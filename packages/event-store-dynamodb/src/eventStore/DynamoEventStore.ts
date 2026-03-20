import {
    DynamoDBDocumentClient,
    QueryCommand,
    UpdateCommand,
    BatchWriteCommand,
    GetCommand
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
        }

        // TODO: implement lock-based and transactional append paths
        throw new Error("Not yet implemented")
    }

    async *read(query: Query, options?: ReadOptions): AsyncGenerator<EventEnvelope> {
        // TODO: implement read with query routing
        throw new Error("Not yet implemented")
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
