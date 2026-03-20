import { DcbEvent, Query, streamAllEventsToArray, Tags } from "@dcb-es/event-store"
import { DynamoEventStore } from "./DynamoEventStore"
import { getTestDynamoTable } from "@test/testDynamoClient"

class EventType1 implements DcbEvent {
    type: "testEvent1" = "testEvent1"
    tags: Tags
    data: Record<string, never>
    metadata: Record<string, never>

    constructor(tags: Tags = Tags.from(["default=tag"])) {
        this.tags = tags
        this.data = {}
        this.metadata = {}
    }
}

class EventType2 implements DcbEvent {
    type: "testEvent2" = "testEvent2"
    tags: Tags
    data: Record<string, never>
    metadata: Record<string, never>

    constructor(tags: Tags = Tags.from(["default=tag"])) {
        this.tags = tags
        this.data = {}
        this.metadata = {}
    }
}

describe("DynamoEventStore.read", () => {
    let client: DynamoDBDocumentClient
    let tableName: string
    let eventStore: DynamoEventStore

    beforeAll(async () => {
        const testTable = await getTestDynamoTable()
        client = testTable.client
        tableName = testTable.tableName
        eventStore = new DynamoEventStore(client, tableName)

        // Seed test data
        const tag1 = Tags.from(["testTagKey=ev-1"])
        const tag2 = Tags.from(["testTagKey=ev-2"])
        const multiTag = Tags.from(["testTagKey=ev-1", "otherTag=shared"])

        await eventStore.append(new EventType1(tag1))
        await eventStore.append(new EventType2(tag2))
        await eventStore.append(new EventType1(multiTag))
        await eventStore.append(new EventType2(tag1))
        await eventStore.append(new EventType1(tag2))
    })

    describe("Query.all()", () => {
        test("should return all events", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(5)
        })

        test("should return events in sequence order", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            for (let i = 1; i < events.length; i++) {
                expect(events[i].sequencePosition.value).toBeGreaterThan(events[i - 1].sequencePosition.value)
            }
        })

        test("should return events backwards", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all(), { backwards: true }))
            expect(events.length).toBe(5)
            for (let i = 1; i < events.length; i++) {
                expect(events[i].sequencePosition.value).toBeLessThan(events[i - 1].sequencePosition.value)
            }
        })

        test("should return events with limit", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all(), { limit: 2 }))
            expect(events.length).toBe(2)
        })

        test("should return events from a sequence position", async () => {
            const allEvents = await streamAllEventsToArray(eventStore.read(Query.all()))
            const fromPos = allEvents[1].sequencePosition

            const events = await streamAllEventsToArray(eventStore.read(Query.all(), { fromSequencePosition: fromPos }))
            expect(events.length).toBe(4)
            expect(events[0].sequencePosition.value).toBe(fromPos.value)
        })

        test("should return events backwards from a sequence position", async () => {
            const allEvents = await streamAllEventsToArray(eventStore.read(Query.all()))
            const fromPos = allEvents[2].sequencePosition

            const events = await streamAllEventsToArray(
                eventStore.read(Query.all(), { fromSequencePosition: fromPos, backwards: true })
            )
            expect(events.length).toBe(3)
            expect(events[0].sequencePosition.value).toBe(fromPos.value)
        })

        test("should return events backwards with limit", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all(), { backwards: true, limit: 1 }))
            expect(events.length).toBe(1)
        })
    })

    describe("query by event types", () => {
        test("should return events matching a single type", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(Query.fromItems([{ eventTypes: ["testEvent1"] }]))
            )
            expect(events.every(e => e.event.type === "testEvent1")).toBe(true)
            expect(events.length).toBe(3)
        })

        test("should return events matching multiple types", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(Query.fromItems([{ eventTypes: ["testEvent1", "testEvent2"] }]))
            )
            expect(events.length).toBe(5)
        })
    })

    describe("query by tags", () => {
        test("should return events matching a tag", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(Query.fromItems([{ tags: Tags.from(["testTagKey=ev-1"]) }]))
            )
            expect(events.length).toBe(3)
            expect(events.every(e => e.event.tags.values.includes("testTagKey=ev-1"))).toBe(true)
        })

        test("should return events matching multiple tags (AND)", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(Query.fromItems([{ tags: Tags.from(["testTagKey=ev-1", "otherTag=shared"]) }]))
            )
            expect(events.length).toBe(1)
        })
    })

    describe("query by types + tags", () => {
        test("should return events matching type AND tag", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(Query.fromItems([{ eventTypes: ["testEvent1"], tags: Tags.from(["testTagKey=ev-1"]) }]))
            )
            expect(events.length).toBe(2)
            expect(events.every(e => e.event.type === "testEvent1")).toBe(true)
            expect(events.every(e => e.event.tags.values.includes("testTagKey=ev-1"))).toBe(true)
        })

        test("should return events matching type AND multiple tags (AND)", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(
                    Query.fromItems([{
                        eventTypes: ["testEvent1"],
                        tags: Tags.from(["testTagKey=ev-1", "otherTag=shared"])
                    }])
                )
            )
            expect(events.length).toBe(1)
            expect(events[0].event.type).toBe("testEvent1")
            expect(events[0].event.tags.values).toContain("testTagKey=ev-1")
            expect(events[0].event.tags.values).toContain("otherTag=shared")
        })
    })

    describe("multiple query items (OR logic)", () => {
        test("should combine query items with OR", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(
                    Query.fromItems([
                        { eventTypes: ["testEvent1"], tags: Tags.from(["testTagKey=ev-1"]) },
                        { eventTypes: ["testEvent2"], tags: Tags.from(["testTagKey=ev-2"]) }
                    ])
                )
            )
            expect(events.length).toBe(3)
        })

        test("should deduplicate events matching multiple query items", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(
                    Query.fromItems([{ eventTypes: ["testEvent1"] }, { tags: Tags.from(["testTagKey=ev-1"]) }])
                )
            )
            const positions = events.map(e => e.sequencePosition.value)
            const uniquePositions = new Set(positions)
            expect(positions.length).toBe(uniquePositions.size)
        })
    })
})
