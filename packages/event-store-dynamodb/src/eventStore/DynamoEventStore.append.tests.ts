import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"
import { AppendCondition, DcbEvent, Query, SequencePosition, Tags } from "@dcb-es/event-store"
import { DynamoEventStore } from "./DynamoEventStore"
import { getTestDynamoTable } from "@test/testDynamoClient"

class EventType1 implements DcbEvent {
    type: "testEvent1" = "testEvent1"
    tags: Tags
    data: Record<string, never>
    metadata: { userId: string } = { userId: "user-1" }

    constructor(tags: Tags = Tags.from(["default=tag"])) {
        this.tags = tags
        this.data = {}
    }
}

describe("DynamoEventStore.append", () => {
    let client: DynamoDBDocumentClient
    let tableName: string
    let eventStore: DynamoEventStore

    beforeAll(async () => {
        const testTable = await getTestDynamoTable()
        client = testTable.client
        tableName = testTable.tableName
        eventStore = new DynamoEventStore(client, tableName)
    })

    describe("append condition validation", () => {
        test("should reject Query.all() in append conditions", async () => {
            const appendCondition: AppendCondition = {
                query: Query.all(),
                expectedCeiling: SequencePosition.zero()
            }
            await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(
                "DynamoDB adapter does not support Query.all() in append conditions"
            )
        })

        test("should reject append condition with missing eventTypes", async () => {
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ tags: Tags.from(["some=tag"]) }]),
                expectedCeiling: SequencePosition.zero()
            }
            await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(
                "DynamoDB adapter requires eventTypes"
            )
        })

        test("should reject append condition with missing tags", async () => {
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ eventTypes: ["testEvent1"] }]),
                expectedCeiling: SequencePosition.zero()
            }
            await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(
                "DynamoDB adapter requires tags"
            )
        })
    })
})
