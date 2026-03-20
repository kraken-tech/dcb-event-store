import {
    DynamoDBDocumentClient,
    QueryCommand,
    BatchGetCommand,
    GetCommand
} from "@aws-sdk/lib-dynamodb"
import { EventEnvelope, ReadOptions, Query, QueryItem, Tags, SequencePosition } from "@dcb-es/event-store"
import { toEventEnvelope, padSeqPos, DynamoEventItem, chunk } from "./utils"

export async function* readFromDynamo(
    client: DynamoDBDocumentClient,
    tableName: string,
    query: Query,
    options?: ReadOptions
): AsyncGenerator<EventEnvelope> {
    const reader = createReader(client, tableName)

    const seqPositions = query.isAll
        ? await reader.collectFromBuckets(options)
        : await reader.collectFromQueryItems(query.items, options)

    const dedupedPositions = deduplicateAndSort(seqPositions, options?.backwards)

    let count = 0
    for (const batch of chunk(dedupedPositions, 100)) {
        // BatchGetItem returns items in arbitrary order — re-sort each batch
        const events = await reader.batchGetEvents(batch)
        const ordered = events.sort((a, b) => {
            const diff = a.sequencePosition.value - b.sequencePosition.value
            return options?.backwards ? -diff : diff
        })

        for (const envelope of ordered) {
            if (options?.limit && count >= options.limit) return
            yield envelope
            count++
        }
    }
}

function createReader(client: DynamoDBDocumentClient, tableName: string) {
    async function queryPartition(
        pk: string,
        fromSequencePosition?: SequencePosition,
        backwards?: boolean
    ): Promise<Record<string, unknown>[]> {
        const expressionValues: Record<string, unknown> = { ":pk": pk }
        let keyCondition = "PK = :pk"

        if (fromSequencePosition) {
            const padded = padSeqPos(fromSequencePosition.value)
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

    async function batchGetEvents(seqPositions: number[]): Promise<EventEnvelope[]> {
        if (seqPositions.length === 0) return []

        const unique = [...new Set(seqPositions)]
        const envelopes: EventEnvelope[] = []

        for (const batch of chunk(unique, 100)) {
            const keys = batch.map(pos => ({ PK: `E#${pos}`, SK: "E" }))

            const result = await client.send(
                new BatchGetCommand({
                    RequestItems: {
                        [tableName]: { Keys: keys, ConsistentRead: true }
                    }
                })
            )

            for (const item of result.Responses?.[tableName] ?? []) {
                envelopes.push(toEventEnvelope(item as DynamoEventItem))
            }
        }

        return envelopes
    }

    async function getMaxBucket(): Promise<number> {
        const result = await client.send(
            new GetCommand({
                TableName: tableName,
                Key: { PK: "_SEQ", SK: "_SEQ" },
                ConsistentRead: true
            })
        )
        return Math.floor(((result.Item?.value as number) ?? 0) / 10000)
    }

    async function collectFromBuckets(options?: ReadOptions): Promise<number[]> {
        const fromSeq = options?.fromSequencePosition?.value ?? 0
        const startBucket = options?.backwards
            ? await getMaxBucket()
            : Math.floor(fromSeq / 10000)

        const positions: number[] = []
        const bucketStep = options?.backwards ? -1 : 1
        let bucket = startBucket

        while (bucket >= 0) {
            const items = await queryPartition(
                `A#${bucket}`,
                options?.fromSequencePosition,
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
        const hasTypes = queryItem.eventTypes && queryItem.eventTypes.length > 0
        const hasTags = queryItem.tags && queryItem.tags.length > 0

        if (hasTypes && hasTags) {
            return collectByTypeAndTag(queryItem.eventTypes!, queryItem.tags!, options)
        } else if (hasTypes) {
            return collectByTypeOnly(queryItem.eventTypes!, options)
        } else if (hasTags) {
            return collectByTagOnly(queryItem.tags!, options)
        }

        return []
    }

    async function collectByTypeAndTag(
        eventTypes: string[],
        tags: Tags,
        options?: ReadOptions
    ): Promise<number[]> {
        const firstTag = tags.values[0]

        const allPositions = await Promise.all(
            eventTypes.map(async type => {
                const items = await queryPartition(
                    `I#${type}#${firstTag}`,
                    options?.fromSequencePosition,
                    options?.backwards
                )
                return items.map(item => item.seqPos as number)
            })
        )

        if (tags.values.length <= 1) {
            return allPositions.flat()
        }

        // Multi-tag: fetch full events to check remaining tags, cache them
        // to avoid re-fetching in readFromDynamo's batchGetEvents
        const candidatePositions = allPositions.flat()
        const events = await batchGetEvents(candidatePositions)
        const remainingTags = tags.values.slice(1)

        return events
            .filter(env => remainingTags.every(tag => env.event.tags.values.includes(tag)))
            .map(env => env.sequencePosition.value)
    }

    async function collectByTypeOnly(eventTypes: string[], options?: ReadOptions): Promise<number[]> {
        const allPositions = await Promise.all(
            eventTypes.map(async type => {
                const items = await queryPartition(
                    `IT#${type}`,
                    options?.fromSequencePosition,
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
            options?.fromSequencePosition,
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
            .map(env => env.sequencePosition.value)
    }

    return { collectFromBuckets, collectFromQueryItems, batchGetEvents }
}

function deduplicateAndSort(positions: number[], backwards?: boolean): number[] {
    const unique = [...new Set(positions)]
    unique.sort((a, b) => backwards ? b - a : a - b)
    return unique
}
