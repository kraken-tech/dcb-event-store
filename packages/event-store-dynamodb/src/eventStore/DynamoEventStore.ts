import {
    DynamoDBDocumentClient,
    QueryCommand,
    UpdateCommand,
    BatchWriteCommand
} from "@aws-sdk/lib-dynamodb"
import {
    EventStore,
    DcbEvent,
    AppendCondition,
    EventEnvelope,
    ReadOptions,
    Query,
    QueryItem
} from "@dcb-es/event-store"
import { toEventEnvelope, toDynamoEventItems, padSeqPos, DynamoEventItem } from "./utils"
import { ensureInstalled } from "./ensureInstalled"

export class DynamoEventStore implements EventStore {
    constructor(
        private client: DynamoDBDocumentClient,
        private tableName: string
    ) {}

    async ensureInstalled(): Promise<void> {
        await ensureInstalled(this.client, this.tableName)
    }

    async append(events: DcbEvent | DcbEvent[], appendCondition?: AppendCondition): Promise<void> {
        const evts = Array.isArray(events) ? events : [events]

        if (appendCondition) {
            this.validateAppendCondition(appendCondition)
            // TODO: implement condition check (chunk 2)
            throw new Error("Append conditions not yet implemented")
        }

        const startSeq = await this.reserveSequenceRange(evts.length)

        const allItems: DynamoEventItem[] = []
        for (let i = 0; i < evts.length; i++) {
            allItems.push(...toDynamoEventItems(evts[i], startSeq + i + 1))
        }

        await this.batchWriteItems(allItems)
    }

    async *read(query: Query, options?: ReadOptions): AsyncGenerator<EventEnvelope> {
        const envelopes = query.isAll
            ? await this.readAll(options)
            : await this.readQueryItems(query.items, options)

        const sorted = envelopes.sort((a, b) => {
            const diff = a.sequencePosition.value - b.sequencePosition.value
            return options?.backwards ? -diff : diff
        })

        let count = 0
        for (const envelope of sorted) {
            if (options?.limit && count >= options.limit) break
            yield envelope
            count++
        }
    }

    private async reserveSequenceRange(count: number): Promise<number> {
        const result = await this.client.send(
            new UpdateCommand({
                TableName: this.tableName,
                Key: { PK: "_SEQ", SK: "_SEQ" },
                UpdateExpression: "ADD #val :inc",
                ExpressionAttributeNames: { "#val": "value" },
                ExpressionAttributeValues: { ":inc": count },
                ReturnValues: "UPDATED_OLD"
            })
        )
        return (result.Attributes?.value as number) ?? 0
    }

    private async batchWriteItems(items: DynamoEventItem[]): Promise<void> {
        const BATCH_SIZE = 25
        const batches: DynamoEventItem[][] = []
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            batches.push(items.slice(i, i + BATCH_SIZE))
        }

        await Promise.all(
            batches.map(async batch => {
                let unprocessed: Record<string, unknown[]> | undefined

                const requestItems = batch.map(item => ({
                    PutRequest: { Item: item }
                }))

                const result = await this.client.send(
                    new BatchWriteCommand({
                        RequestItems: { [this.tableName]: requestItems }
                    })
                )

                unprocessed = result.UnprocessedItems as Record<string, unknown[]> | undefined
                while (unprocessed && unprocessed[this.tableName]?.length > 0) {
                    const retry = await this.client.send(
                        new BatchWriteCommand({ RequestItems: unprocessed as Record<string, any> })
                    )
                    unprocessed = retry.UnprocessedItems as Record<string, unknown[]> | undefined
                }
            })
        )
    }

    private async readAll(options?: ReadOptions): Promise<EventEnvelope[]> {
        const fromSeq = options?.fromSequencePosition?.value ?? (options?.backwards ? Infinity : 0)
        const startBucket = options?.backwards
            ? await this.getMaxBucket()
            : Math.floor((fromSeq as number) / 10000)

        const results: EventEnvelope[] = []
        const bucketStep = options?.backwards ? -1 : 1
        let bucket = startBucket

        while (bucket >= 0) {
            const items = await this.queryPartition(
                `A#${bucket}`,
                options?.fromSequencePosition,
                options?.backwards
            )

            for (const item of items) {
                results.push(toEventEnvelope(item as DynamoEventItem))
            }

            if (!options?.backwards && items.length === 0) break
            bucket += bucketStep
            if (options?.backwards && bucket < 0) break
            if (!options?.backwards && items.length === 0) break
        }

        return results
    }

    private async getMaxBucket(): Promise<number> {
        const result = await this.client.send(
            new QueryCommand({
                TableName: this.tableName,
                KeyConditionExpression: "PK = :pk",
                ExpressionAttributeValues: { ":pk": "_SEQ" },
                ConsistentRead: true
            })
        )
        const seqValue = result.Items?.[0]?.value as number ?? 0
        return Math.floor(seqValue / 10000)
    }

    private async readQueryItems(queryItems: QueryItem[], options?: ReadOptions): Promise<EventEnvelope[]> {
        const allResults = await Promise.all(
            queryItems.map(item => this.readSingleQueryItem(item, options))
        )

        const seenPositions = new Set<number>()
        const deduped: EventEnvelope[] = []
        const merged = allResults.flat()

        merged.sort((a, b) => a.sequencePosition.value - b.sequencePosition.value)

        for (const envelope of merged) {
            if (!seenPositions.has(envelope.sequencePosition.value)) {
                seenPositions.add(envelope.sequencePosition.value)
                deduped.push(envelope)
            }
        }

        return deduped
    }

    private async readSingleQueryItem(queryItem: QueryItem, options?: ReadOptions): Promise<EventEnvelope[]> {
        const hasTypes = queryItem.eventTypes && queryItem.eventTypes.length > 0
        const hasTags = queryItem.tags && queryItem.tags.length > 0

        if (hasTypes && hasTags) {
            return this.readByTypeAndTag(queryItem, options)
        } else if (hasTypes) {
            return this.readByTypeOnly(queryItem.eventTypes!, options)
        } else if (hasTags) {
            return this.readByTagOnly(queryItem.tags!, options)
        }

        return []
    }

    private async readByTypeAndTag(queryItem: QueryItem, options?: ReadOptions): Promise<EventEnvelope[]> {
        const firstTag = queryItem.tags!.values[0]
        const remainingTags = queryItem.tags!.values.slice(1)

        const allResults = await Promise.all(
            queryItem.eventTypes!.map(async type => {
                const pk = `I#${type}#${firstTag}`
                const items = await this.queryPartition(pk, options?.fromSequencePosition, options?.backwards)
                return items
                    .map(item => toEventEnvelope(item as DynamoEventItem))
                    .filter(env => remainingTags.every(tag => env.event.tags.values.includes(tag)))
            })
        )

        return allResults.flat()
    }

    private async readByTypeOnly(eventTypes: string[], options?: ReadOptions): Promise<EventEnvelope[]> {
        const allResults = await Promise.all(
            eventTypes.map(async type => {
                const items = await this.queryPartition(`IT#${type}`, options?.fromSequencePosition, options?.backwards)
                return items.map(item => toEventEnvelope(item as DynamoEventItem))
            })
        )
        return allResults.flat()
    }

    private async readByTagOnly(tags: import("@dcb-es/event-store").Tags, options?: ReadOptions): Promise<EventEnvelope[]> {
        const firstTag = tags.values[0]
        const remainingTags = tags.values.slice(1)

        const items = await this.queryPartition(`IG#${firstTag}`, options?.fromSequencePosition, options?.backwards)
        return items
            .map(item => toEventEnvelope(item as DynamoEventItem))
            .filter(env => remainingTags.every(tag => env.event.tags.values.includes(tag)))
    }

    private async queryPartition(
        pk: string,
        fromSequencePosition?: import("@dcb-es/event-store").SequencePosition,
        backwards?: boolean
    ): Promise<Record<string, unknown>[]> {
        const expressionValues: Record<string, unknown> = { ":pk": pk }
        let keyCondition = "PK = :pk"

        if (fromSequencePosition) {
            const padded = padSeqPos(fromSequencePosition.value)
            if (backwards) {
                keyCondition += " AND SK <= :fromPos"
            } else {
                keyCondition += " AND SK >= :fromPos"
            }
            expressionValues[":fromPos"] = padded
        }

        const allItems: Record<string, unknown>[] = []
        let exclusiveStartKey: Record<string, unknown> | undefined

        do {
            const result = await this.client.send(
                new QueryCommand({
                    TableName: this.tableName,
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

    private validateAppendCondition(condition: AppendCondition): void {
        if (condition.query.isAll) {
            throw new Error(
                "DynamoDB adapter does not support Query.all() in append conditions. Use specific event types and tags."
            )
        }

        for (const item of condition.query.items) {
            if (!item.eventTypes || item.eventTypes.length === 0) {
                throw new Error("DynamoDB adapter requires eventTypes in every append condition QueryItem")
            }
            if (!item.tags || item.tags.length === 0) {
                throw new Error("DynamoDB adapter requires tags in every append condition QueryItem")
            }
        }
    }
}
