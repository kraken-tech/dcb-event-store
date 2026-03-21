import {
    DynamoDBDocumentClient,
    UpdateCommand,
    BatchWriteCommand,
    PutCommand,
    QueryCommand,
    ScanCommand,
    GetCommand
} from "@aws-sdk/lib-dynamodb"
import {
    EventStore,
    DcbEvent,
    AppendCondition,
    AppendConditionError,
    SequencedEvent,
    ReadOptions,
    Query
} from "@dcb-es/event-store"
import { buildWriteBatch, DynamoEventItem, DynamoPointerItem, chunk, padSeqPos } from "./utils"
import { ensureInstalled } from "./ensureInstalled"
import { readFromDynamo } from "./readDynamo"
import { acquireLocks, releaseLocks, startHeartbeat, HeartbeatHandle } from "./lockManager"
import { markBatchFailed } from "./batchUtils"

const MAX_BATCH_WRITE_RETRIES = 5
const BATCH_WRITE_SIZE = 25
const BACKOFF_BASE_MS = 100
const MAX_BACKOFF_MS = 5_000
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_LOCK_TIMEOUT_MS = 30_000

export class DynamoEventStore implements EventStore {
    constructor(
        private client: DynamoDBDocumentClient,
        private tableName: string
    ) {}

    async ensureInstalled(): Promise<void> {
        await ensureInstalled(this.client, this.tableName)
        await this.initSequenceCounter()
    }

    async append(events: DcbEvent | DcbEvent[], condition?: AppendCondition): Promise<void> {
        const eventArray = Array.isArray(events) ? events : [events]

        if (condition) {
            this.validateAppendCondition(condition)
            await this.appendWithCondition(eventArray, condition)
            return
        }

        const startSeq = await this.reserveSequenceRange(eventArray.length)

        const allItems: (DynamoEventItem | DynamoPointerItem)[] = []
        for (let i = 0; i < eventArray.length; i++) {
            const batch = buildWriteBatch(eventArray[i], startSeq + i + 1)
            allItems.push(batch.event, ...batch.pointers)
        }

        await this.batchWriteItems(allItems)
    }

    private async appendWithCondition(events: DcbEvent[], condition: AppendCondition): Promise<void> {
        // Step 1: Create batch record
        const batchId = crypto.randomUUID()
        await this.createBatchRecord(batchId)

        // Step 2: Compute lock keys
        const lockKeys = this.computeLockKeys(condition, events)

        // Step 3: Acquire locks
        const lockResult = await acquireLocks(this.client, this.tableName, lockKeys, batchId, {
            leaseDurationMs: DEFAULT_LEASE_MS,
            timeoutMs: DEFAULT_LOCK_TIMEOUT_MS
        })

        if (!lockResult.acquired) {
            throw new AppendConditionError(condition)
        }

        // Step 3b: Start heartbeat
        let heartbeat: HeartbeatHandle | undefined
        try {
            heartbeat = startHeartbeat(this.client, this.tableName, lockKeys, batchId, {
                intervalMs: DEFAULT_HEARTBEAT_MS,
                leaseDurationMs: DEFAULT_LEASE_MS
            })

            // Step 4: Check append condition (strongly consistent reads)
            await this.checkCondition(condition)

            // Step 5: Reserve sequence range
            const startSeq = await this.reserveSequenceRange(events.length)

            // Update batch with sequence range
            await this.client.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { PK: `_BATCH#${batchId}`, SK: `_BATCH#${batchId}` },
                    UpdateExpression: "SET seqStart = :start, seqEnd = :end",
                    ExpressionAttributeValues: { ":start": startSeq + 1, ":end": startSeq + events.length }
                })
            )

            // Step 6: Write events with batchId
            const allItems: (DynamoEventItem | DynamoPointerItem)[] = []
            for (let i = 0; i < events.length; i++) {
                const batch = buildWriteBatch(events[i], startSeq + i + 1, batchId)
                allItems.push(batch.event, ...batch.pointers)
            }
            await this.batchWriteItems(allItems)

            // Step 7: Fenced commit
            await this.commitBatch(batchId)

            // Step 7b: Advance _COMMITTED_THROUGH watermark
            await this.advanceWatermark()

            // Step 8: Stop heartbeat + release locks
            heartbeat.stop()
            await releaseLocks(this.client, this.tableName, lockKeys, batchId)
        } catch (error) {
            // Cleanup on any error
            heartbeat?.stop()
            await markBatchFailed(this.client, this.tableName, batchId)
            await releaseLocks(this.client, this.tableName, lockKeys, batchId)
            throw error
        }
    }

    private computeLockKeys(condition: AppendCondition, events: DcbEvent[]): string[] {
        const keys = new Set<string>()

        // From condition query items: cartesian product of types × tags
        for (const item of condition.failIfEventsMatch.items) {
            for (const type of item.types ?? []) {
                for (const tag of item.tags?.values ?? []) {
                    keys.add(`${type}:${tag}`)
                }
            }
        }

        // From events: cartesian product of event type × event tags
        for (const event of events) {
            for (const tag of event.tags.values) {
                keys.add(`${event.type}:${tag}`)
            }
        }

        return [...keys].sort()
    }

    private async checkCondition(condition: AppendCondition): Promise<void> {
        const afterPos = padSeqPos(condition.after.value)

        const checks = condition.failIfEventsMatch.items.flatMap(item =>
            (item.types ?? []).flatMap(type =>
                (item.tags?.values ?? []).map(tag => ({ type, tag }))
            )
        )

        const results = await Promise.all(
            checks.map(async ({ type, tag }) => {
                const result = await this.client.send(
                    new QueryCommand({
                        TableName: this.tableName,
                        KeyConditionExpression: "PK = :pk AND SK > :pos",
                        ExpressionAttributeValues: {
                            ":pk": `I#${type}#${tag}`,
                            ":pos": afterPos
                        },
                        ConsistentRead: true,
                        Limit: 1
                    })
                )
                return (result.Items?.length ?? 0) > 0
            })
        )

        if (results.some(found => found)) {
            throw new AppendConditionError(condition)
        }
    }

    private async createBatchRecord(batchId: string): Promise<void> {
        await this.client.send(
            new PutCommand({
                TableName: this.tableName,
                Item: {
                    PK: `_BATCH#${batchId}`,
                    SK: `_BATCH#${batchId}`,
                    status: "PENDING",
                    createdAt: Date.now()
                }
            })
        )
    }

    private async commitBatch(batchId: string): Promise<void> {
        try {
            await this.client.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { PK: `_BATCH#${batchId}`, SK: `_BATCH#${batchId}` },
                    UpdateExpression: "SET #s = :committed",
                    ConditionExpression: "#s = :pending",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: { ":committed": "COMMITTED", ":pending": "PENDING" }
                })
            )
        } catch (e: unknown) {
            if ((e as { name?: string }).name === "ConditionalCheckFailedException") {
                throw new Error("Batch commit failed: batch was marked FAILED (fencing)")
            }
            throw e
        }
    }

    private async advanceWatermark(): Promise<void> {
        // Scan for PENDING batches to find the lowest seqStart
        const pendingBatches: number[] = []
        let lastKey: Record<string, unknown> | undefined

        do {
            const result = await this.client.send(
                new ScanCommand({
                    TableName: this.tableName,
                    FilterExpression: "begins_with(PK, :prefix) AND #s = :pending",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: { ":prefix": "_BATCH#", ":pending": "PENDING" },
                    ProjectionExpression: "seqStart",
                    ExclusiveStartKey: lastKey
                })
            )

            for (const item of result.Items ?? []) {
                if (item.seqStart !== undefined) {
                    pendingBatches.push(item.seqStart as number)
                }
            }

            lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined
        } while (lastKey)

        let newWatermark: number
        if (pendingBatches.length === 0) {
            // No PENDING batches — safe to advance to current _SEQ
            const seqResult = await this.client.send(
                new GetCommand({
                    TableName: this.tableName,
                    Key: { PK: "_SEQ", SK: "_SEQ" },
                    ConsistentRead: true
                })
            )
            newWatermark = (seqResult.Item?.value as number) ?? 0
        } else {
            // PENDING batches exist — watermark is min(seqStart) - 1
            newWatermark = Math.min(...pendingBatches) - 1
        }

        if (newWatermark <= 0) return

        // Conditional advance — can only move forward
        try {
            await this.client.send(
                new UpdateCommand({
                    TableName: this.tableName,
                    Key: { PK: "_COMMITTED_THROUGH", SK: "_COMMITTED_THROUGH" },
                    UpdateExpression: "SET #val = :new",
                    ConditionExpression: "attribute_not_exists(#val) OR #val < :new",
                    ExpressionAttributeNames: { "#val": "value" },
                    ExpressionAttributeValues: { ":new": newWatermark }
                })
            )
        } catch (e: unknown) {
            if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e
            // Another committer already advanced further — fine
        }
    }

    async *read(query: Query, options?: ReadOptions): AsyncGenerator<SequencedEvent> {
        yield* readFromDynamo(this.client, this.tableName, query, options)
    }

    private async initSequenceCounter(): Promise<void> {
        try {
            await this.client.send(
                new PutCommand({
                    TableName: this.tableName,
                    Item: { PK: "_SEQ", SK: "_SEQ", value: 0 },
                    ConditionExpression: "attribute_not_exists(PK)"
                })
            )
        } catch (e: unknown) {
            if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e
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

    private async batchWriteItems(items: (DynamoEventItem | DynamoPointerItem)[]): Promise<void> {
        await Promise.all(
            chunk(items, BATCH_WRITE_SIZE).map(async batch => {
                const requestItems = batch.map(item => ({
                    PutRequest: { Item: item }
                }))

                let unprocessed = (
                    await this.client.send(
                        new BatchWriteCommand({
                            RequestItems: { [this.tableName]: requestItems }
                        })
                    )
                ).UnprocessedItems

                let retries = 0
                while (unprocessed?.[this.tableName]?.length && retries < MAX_BATCH_WRITE_RETRIES) {
                    retries++
                    await new Promise(resolve =>
                        setTimeout(resolve, Math.min(BACKOFF_BASE_MS * 2 ** retries, MAX_BACKOFF_MS))
                    )
                    const result = await this.client.send(
                        new BatchWriteCommand({ RequestItems: unprocessed! })
                    )
                    unprocessed = result.UnprocessedItems
                }

                if (unprocessed?.[this.tableName]?.length) {
                    throw new Error(`Failed to write all items after ${MAX_BATCH_WRITE_RETRIES} retries`)
                }
            })
        )
    }

    private validateAppendCondition(condition: AppendCondition): void {
        if (condition.failIfEventsMatch.isAll) {
            throw new Error(
                "DynamoDB adapter does not support Query.all() in append conditions. Use specific event types and tags."
            )
        }

        for (const item of condition.failIfEventsMatch.items) {
            if (!item.types || item.types.length === 0) {
                throw new Error("DynamoDB adapter requires types in every append condition QueryItem")
            }
            if (!item.tags || item.tags.length === 0) {
                throw new Error("DynamoDB adapter requires tags in every append condition QueryItem")
            }
        }
    }
}
