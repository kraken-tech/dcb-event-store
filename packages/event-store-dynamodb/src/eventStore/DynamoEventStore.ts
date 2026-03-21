import {
    DynamoDBDocumentClient,
    UpdateCommand,
    BatchWriteCommand,
    PutCommand
} from "@aws-sdk/lib-dynamodb"
import {
    EventStore,
    DcbEvent,
    AppendCondition,
    SequencedEvent,
    ReadOptions,
    Query
} from "@dcb-es/event-store"
import { buildWriteBatch, DynamoEventItem, DynamoPointerItem, chunk } from "./utils"
import { ensureInstalled } from "./ensureInstalled"
import { readFromDynamo } from "./readDynamo"

const MAX_BATCH_WRITE_RETRIES = 5

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
            // TODO: implement lock-based conditional append (#44)
            throw new Error("Append conditions not yet implemented")
        }

        const startSeq = await this.reserveSequenceRange(eventArray.length)

        const allItems: (DynamoEventItem | DynamoPointerItem)[] = []
        for (let i = 0; i < eventArray.length; i++) {
            const batch = buildWriteBatch(eventArray[i], startSeq + i + 1)
            allItems.push(batch.event, ...batch.pointers)
        }

        await this.batchWriteItems(allItems)
    }

    async *read(query: Query, options?: ReadOptions): AsyncGenerator<SequencedEvent> {
        yield* readFromDynamo(this.client, this.tableName, query, options)
    }

    private async initSequenceCounter(): Promise<void> {
        await this.client.send(
            new PutCommand({
                TableName: this.tableName,
                Item: { PK: "_SEQ", SK: "_SEQ", value: 0 },
                ConditionExpression: "attribute_not_exists(PK)"
            })
        ).catch(e => {
            if (e.name !== "ConditionalCheckFailedException") throw e
        })
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
            chunk(items, 25).map(async batch => {
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
                    await new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** retries, 5000)))
                    const result = await this.client.send(
                        new BatchWriteCommand({ RequestItems: unprocessed as Record<string, any> })
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
