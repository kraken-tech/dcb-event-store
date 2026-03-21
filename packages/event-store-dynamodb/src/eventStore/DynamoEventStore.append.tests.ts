import { AppendCondition, DcbEvent, Query, SequencePosition, streamAllEventsToArray, Tags } from "@dcb-es/event-store"
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

class EventType2 implements DcbEvent {
    type: "testEvent2" = "testEvent2"
    tags: Tags
    data: Record<string, never>
    metadata: { userId: string } = { userId: "user-1" }

    constructor(tags: Tags = Tags.from(["default=tag"])) {
        this.tags = tags
        this.data = {}
    }
}

const createEventStore = async () => {
    const { client, tableName } = await getTestDynamoTable()
    return new DynamoEventStore(client, tableName)
}

describe("DynamoEventStore.append", () => {
    describe("when event store is empty", () => {
        let eventStore: DynamoEventStore

        beforeAll(async () => {
            eventStore = await createEventStore()
        })

        test("should return an empty array when no events are stored", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(0)
        })

        test("should assign a sequence position on appending the first event", async () => {
            await eventStore.append(new EventType1())
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(1)
            expect(events[0].position.value).toBeGreaterThan(0)
        })

        test("should store and return metadata on event successfully", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            const lastEvent = events.at(-1)?.event as EventType1
            expect(lastEvent.metadata.userId).toBe("user-1")
        })
    })

    describe("append condition validation", () => {
        let eventStore: DynamoEventStore

        beforeAll(async () => {
            eventStore = await createEventStore()
        })

        test("should reject Query.all() in append conditions", async () => {
            const condition: AppendCondition = {
                failIfEventsMatch: Query.all(),
                after: SequencePosition.zero()
            }
            await expect(eventStore.append(new EventType1(), condition)).rejects.toThrow(
                "DynamoDB adapter does not support Query.all() in append conditions"
            )
        })

        test("should reject append condition with missing types", async () => {
            const condition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ tags: Tags.from(["some=tag"]) }]),
                after: SequencePosition.zero()
            }
            await expect(eventStore.append(new EventType1(), condition)).rejects.toThrow(
                "DynamoDB adapter requires types"
            )
        })

        test("should reject append condition with missing tags", async () => {
            const condition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"] }]),
                after: SequencePosition.zero()
            }
            await expect(eventStore.append(new EventType1(), condition)).rejects.toThrow(
                "DynamoDB adapter requires tags"
            )
        })
    })

    describe("append without condition", () => {
        let eventStore: DynamoEventStore

        beforeAll(async () => {
            eventStore = await createEventStore()
        })

        test("should append events without any condition", async () => {
            await eventStore.append(new EventType1())
            await eventStore.append(new EventType2())
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(2)
        })

        test("should assign increasing sequence positions", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events[1].position.value).toBeGreaterThan(events[0].position.value)
        })

        test("should append multiple events in a single call", async () => {
            await eventStore.append([new EventType1(), new EventType1(), new EventType2()])
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(5)
        })
    })
})
