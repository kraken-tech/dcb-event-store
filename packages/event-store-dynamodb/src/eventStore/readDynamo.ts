import {
    DynamoDBDocumentClient,
    QueryCommand,
    BatchGetCommand,
    GetCommand
} from "@aws-sdk/lib-dynamodb"
import { SequencedEvent, ReadOptions, Query, QueryItem, Tags, SequencePosition } from "@dcb-es/event-store"
import { toSequencedEvent, padSeqPos, DynamoEventItem, chunk, BUCKET_SIZE } from "./utils"

export async function* readFromDynamo(
    client: DynamoDBDocumentClient,
    tableName: string,
    query: Query,
    options?: ReadOptions
): AsyncGenerator<SequencedEvent> {
    const committedBatchCache = new Set<string>()
    const failedBatchCache = new Set<string>()
    const reader = createReader(client, tableName)

    const seqPositions = query.isAll
        ? await reader.collectFromBuckets(options)
        : await reader.collectFromQueryItems(query.items, options)

    const dedupedPositions = deduplicateAndSort(seqPositions, options?.backwards)

    let count = 0
    for (const batch of chunk(dedupedPositions, 100)) {
        const rawEvents = await reader.batchGetEventsWithItems(batch)

        // Filter by batch status
        const visibleEvents = await filterByBatchStatus(
            client, tableName, rawEvents, committedBatchCache, failedBatchCache
        )

        const ordered = visibleEvents.sort((a, b) => {
            const diff = a.position.value - b.position.value
            return options?.backwards ? -diff : diff
        })

        for (const event of ordered) {
            if (options?.limit && count >= options.limit) return
            yield event
            count++
        }
    }
}

async function filterByBatchStatus(
    client: DynamoDBDocumentClient,
    tableName: string,
    events: { item: DynamoEventItem; sequenced: SequencedEvent }[],
    committedCache: Set<string>,
    failedCache: Set<string>
): Promise<SequencedEvent[]> {
    // Separate events with and without batchId
    const visible: SequencedEvent[] = []
    const needsCheck: { item: DynamoEventItem; sequenced: SequencedEvent }[] = []

    for (const entry of events) {
        if (!entry.item.batchId) {
            visible.push(entry.sequenced)
        } else if (committedCache.has(entry.item.batchId)) {
            visible.push(entry.sequenced)
        } else if (failedCache.has(entry.item.batchId)) {
            // Skip — FAILED batch
        } else {
            needsCheck.push(entry)
        }
    }

    if (needsCheck.length === 0) return visible

    // Batch-fetch unknown batch statuses
    const unknownBatchIds = [...new Set(needsCheck.map(e => e.item.batchId!))]
    const batchKeys = unknownBatchIds.map(id => ({ PK: `_BATCH#${id}`, SK: `_BATCH#${id}` }))

    for (const keyChunk of chunk(batchKeys, 100)) {
        const result = await client.send(
            new BatchGetCommand({
                RequestItems: { [tableName]: { Keys: keyChunk, ConsistentRead: true } }
            })
        )
        for (const item of result.Responses?.[tableName] ?? []) {
            const batchId = (item.PK as string).replace("_BATCH#", "")
            if (item.status === "COMMITTED") {
                committedCache.add(batchId)
            } else {
                failedCache.add(batchId)
            }
        }
        // Missing batch records are treated as failed
        for (const key of keyChunk) {
            const batchId = (key.PK as string).replace("_BATCH#", "")
            if (!committedCache.has(batchId) && !failedCache.has(batchId)) {
                failedCache.add(batchId)
            }
        }
    }

    // Re-check with populated cache
    for (const entry of needsCheck) {
        if (committedCache.has(entry.item.batchId!)) {
            visible.push(entry.sequenced)
        }
    }

    return visible
}

function createReader(client: DynamoDBDocumentClient, tableName: string) {
    async function queryPartition(
        pk: string,
        fromPosition?: SequencePosition,
        backwards?: boolean
    ): Promise<Record<string, unknown>[]> {
        const expressionValues: Record<string, unknown> = { ":pk": pk }
        let keyCondition = "PK = :pk"

        if (fromPosition) {
            const padded = padSeqPos(fromPosition.value)
            keyCondition += backwards ? " AND SK <= :fromPos" : " AND SK >= :fromPos"
            expressionValues[":fromPos"] = padded
        }

        const allItems: Record<string, unknown>[] = []
        let exclusiveStartKey: Record<string, unknown> | undefined

        do {
            const result = await client.send(
                new QueryCommand({
                    TableName: tableName,
                    KeyConditionExpression: keyCondition,
                    ExpressionAttributeValues: expressionValues,
                    ScanIndexForward: !backwards,
                    ExclusiveStartKey: exclusiveStartKey
                })
            )

            if (result.Items) {
                allItems.push(...result.Items)
            }

            exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined
        } while (exclusiveStartKey)

        return allItems
    }

    async function batchGetEvents(seqPositions: number[]): Promise<SequencedEvent[]> {
        const results = await batchGetEventsWithItems(seqPositions)
        return results.map(r => r.sequenced)
    }

    async function batchGetEventsWithItems(seqPositions: number[]): Promise<{ item: DynamoEventItem; sequenced: SequencedEvent }[]> {
        if (seqPositions.length === 0) return []

        const entries: { item: DynamoEventItem; sequenced: SequencedEvent }[] = []

        for (const batch of chunk(seqPositions, 100)) {
            const keys = batch.map(pos => ({ PK: `E#${pos}`, SK: "E" }))

            const result = await client.send(
                new BatchGetCommand({
                    RequestItems: {
                        [tableName]: { Keys: keys, ConsistentRead: true }
                    }
                })
            )

            for (const item of result.Responses?.[tableName] ?? []) {
                const dynamoItem = item as DynamoEventItem
                entries.push({ item: dynamoItem, sequenced: toSequencedEvent(dynamoItem) })
            }
        }

        return entries
    }

    async function getMaxBucket(): Promise<number> {
        const result = await client.send(
            new GetCommand({
                TableName: tableName,
                Key: { PK: "_SEQ", SK: "_SEQ" },
                ConsistentRead: true
            })
        )
        return Math.floor(((result.Item?.value as number) ?? 0) / BUCKET_SIZE)
    }

    async function collectFromBuckets(options?: ReadOptions): Promise<number[]> {
        const fromSeq = options?.fromPosition?.value ?? 0
        const startBucket = options?.backwards
            ? await getMaxBucket()
            : Math.floor(fromSeq / BUCKET_SIZE)

        const positions: number[] = []
        const bucketStep = options?.backwards ? -1 : 1
        let bucket = startBucket

        while (bucket >= 0) {
            const items = await queryPartition(
                `A#${bucket}`,
                options?.fromPosition,
                options?.backwards
            )

            for (const item of items) {
                positions.push(item.seqPos as number)
            }

            if (!options?.backwards && items.length === 0) break
            bucket += bucketStep
            if (options?.backwards && bucket < 0) break
        }

        return positions
    }

    async function collectFromQueryItems(queryItems: QueryItem[], options?: ReadOptions): Promise<number[]> {
        const allPositions = await Promise.all(
            queryItems.map(item => collectFromSingleQueryItem(item, options))
        )
        return allPositions.flat()
    }

    async function collectFromSingleQueryItem(queryItem: QueryItem, options?: ReadOptions): Promise<number[]> {
        const hasTypes = queryItem.types && queryItem.types.length > 0
        const hasTags = queryItem.tags && queryItem.tags.length > 0

        if (hasTypes && hasTags) {
            return collectByTypeAndTag(queryItem.types!, queryItem.tags!, options)
        } else if (hasTypes) {
            return collectByTypeOnly(queryItem.types!, options)
        } else if (hasTags) {
            return collectByTagOnly(queryItem.tags!, options)
        }

        return []
    }

    async function collectByTypeAndTag(
        types: string[],
        tags: Tags,
        options?: ReadOptions
    ): Promise<number[]> {
        const firstTag = tags.values[0]

        const allPositions = await Promise.all(
            types.map(async type => {
                const items = await queryPartition(
                    `I#${type}#${firstTag}`,
                    options?.fromPosition,
                    options?.backwards
                )
                return items.map(item => item.seqPos as number)
            })
        )

        if (tags.values.length <= 1) {
            return allPositions.flat()
        }

        // Multi-tag: fetch full events to check remaining tags
        const candidatePositions = allPositions.flat()
        const events = await batchGetEvents(candidatePositions)
        const remainingTags = tags.values.slice(1)

        return events
            .filter(env => remainingTags.every(tag => env.event.tags.values.includes(tag)))
            .map(env => env.position.value)
    }

    async function collectByTypeOnly(types: string[], options?: ReadOptions): Promise<number[]> {
        const allPositions = await Promise.all(
            types.map(async type => {
                const items = await queryPartition(
                    `IT#${type}`,
                    options?.fromPosition,
                    options?.backwards
                )
                return items.map(item => item.seqPos as number)
            })
        )
        return allPositions.flat()
    }

    async function collectByTagOnly(tags: Tags, options?: ReadOptions): Promise<number[]> {
        const firstTag = tags.values[0]

        const items = await queryPartition(
            `IG#${firstTag}`,
            options?.fromPosition,
            options?.backwards
        )

        if (tags.values.length <= 1) {
            return items.map(item => item.seqPos as number)
        }

        // Multi-tag: fetch full events to check remaining tags
        const candidatePositions = items.map(item => item.seqPos as number)
        const events = await batchGetEvents(candidatePositions)
        const remainingTags = tags.values.slice(1)

        return events
            .filter(env => remainingTags.every(tag => env.event.tags.values.includes(tag)))
            .map(env => env.position.value)
    }

    return { collectFromBuckets, collectFromQueryItems, batchGetEvents, batchGetEventsWithItems }
}

function deduplicateAndSort(positions: number[], backwards?: boolean): number[] {
    const unique = [...new Set(positions)]
    unique.sort((a, b) => backwards ? b - a : a - b)
    return unique
}
