import { DcbEvent, streamAllEventsToArray, SequencePosition, Tags, Query } from "@dcb-es/event-store"
import { Pool, PoolClient } from "pg"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { PostgresEventStore } from "./PostgresEventStore"

class EventType1 implements DcbEvent {
    type: "testEvent1" = "testEvent1"
    tags: Tags
    data: Record<string, never>
    metadata: Record<string, never> = {}

    constructor(tagValue?: string) {
        this.tags = tagValue ? Tags.fromObj({ testTagKey: tagValue }) : Tags.createEmpty()
        this.data = {}
    }
}

class EventType2 implements DcbEvent {
    type: "testEvent2" = "testEvent2"
    tags: Tags
    data: Record<string, never>
    metadata: Record<string, never> = {}

    constructor(tagValue?: string) {
        this.tags = tagValue ? Tags.fromObj({ testTagKey: tagValue }) : Tags.createEmpty()
        this.data = {}
    }
}

describe("postgresEventStore.query", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    let client: PoolClient

    beforeAll(async () => {
        pool = await getTestPgDatabasePool()
        eventStore = new PostgresEventStore(pool)
        await eventStore.ensureInstalled()
    })
    beforeEach(async () => {
        client = await pool.connect()
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        eventStore = new PostgresEventStore(client)
    })

    afterEach(async () => {
        await client.query("COMMIT")
        client.release()
        await pool.query("TRUNCATE table events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    describe("when event store is empty", () => {
        test("should return no events when read forward", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(0)
        })

        test("should return no events when read backward", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(0)
        })
    })

    describe("when event store contains exactly one event", () => {
        beforeEach(async () => {
            await eventStore.append(new EventType1("ev-1"))
        })

        test("should return a single event when read forward", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(1)
        })

        test("should return a single event when read backward", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all(), { backwards: true }))
            expect(events.length).toBe(1)
        })
    })

    describe("when event store contains two events", () => {
        beforeEach(async () => {
            await eventStore.append(new EventType1("ev-1"))
            await eventStore.append(new EventType2("ev-2"))
        })

        describe("with a fromSequencePosition filter applied", () => {
            test("should return both events when readAll called with no filter", async () => {
                const events = await streamAllEventsToArray(eventStore.read(Query.all()))
                expect(events.length).toBe(2)
                expect(events[0].sequencePosition.value).toBe(1)
                expect(events[1].sequencePosition.value).toBe(2)
            })

            test("should return both events when readAll called with backwards and no filter", async () => {
                const events = await streamAllEventsToArray(eventStore.read(Query.all(), { backwards: true }))
                expect(events.length).toBe(2)
                expect(events[0].sequencePosition.value).toBe(2)
                expect(events[1].sequencePosition.value).toBe(1)
            })

            test("should return the second event when read forward from sequence number 2", async () => {
                const events = await streamAllEventsToArray(
                    eventStore.read(Query.all(), { fromSequencePosition: SequencePosition.create(2) })
                )
                expect(events.length).toBe(1)
                expect(events[0].sequencePosition.value).toBe(2)
            })

            test("should return the first event when read backward from sequence number 1", async () => {
                const events = await streamAllEventsToArray(
                    eventStore.read(Query.all(), { fromSequencePosition: SequencePosition.create(1), backwards: true })
                )
                expect(events.length).toBe(1)
                expect(events[0].sequencePosition.value).toBe(1)
            })

            test("should return both first and second event when read backward from sequence number 2", async () => {
                const events = await streamAllEventsToArray(
                    eventStore.read(Query.all(), { fromSequencePosition: SequencePosition.create(2), backwards: true })
                )
                expect(events.length).toBe(2)
            })
        })

        describe("when filtered by event types", () => {
            test("should return the event of type 'testEvent1' when read forward with event type filter", async () => {
                const events = await streamAllEventsToArray(
                    eventStore.read(Query.fromItems([{ eventTypes: ["testEvent1"], tags: Tags.createEmpty() }]))
                )
                expect(events.length).toBe(1)
                expect(events[0].event.type).toBe("testEvent1")
            })
        })

        describe("when filtered by tags", () => {
            test("should return no events when tag keys do not match", async () => {
                const events = await streamAllEventsToArray(
                    eventStore.read(Query.fromItems([{ eventTypes: [], tags: Tags.fromObj({ unmatchedId: "ev-1" }) }]))
                )
                expect(events.length).toBe(0)
            })

            test("should return the event matching specific tag key when read forward", async () => {
                const events = await streamAllEventsToArray(
                    eventStore.read(Query.fromItems([{ eventTypes: [], tags: Tags.fromObj({ testTagKey: "ev-1" }) }]))
                )
                expect(events.length).toBe(1)
                expect(events[0].event.tags.equals(Tags.fromObj({ testTagKey: "ev-1" }))).toEqual(true)
            })

            test("should return matching events when query has tags but no eventTypes property", async () => {
                const events = await streamAllEventsToArray(
                    eventStore.read(Query.fromItems([{ tags: Tags.fromObj({ testTagKey: "ev-1" }) }]))
                )
                expect(events.length).toBe(1)
                expect(events[0].event.tags.equals(Tags.fromObj({ testTagKey: "ev-1" }))).toEqual(true)
            })

            test("should return all matching events across types when filtering by tag only", async () => {
                const events = await streamAllEventsToArray(
                    eventStore.read(Query.fromItems([{ tags: Tags.fromObj({ testTagKey: "ev-2" }) }]))
                )
                expect(events.length).toBe(1)
                expect(events[0].event.type).toBe("testEvent2")
            })
        })
    })

    describe("when event store contains three events", () => {
        beforeEach(async () => {
            await eventStore.append(new EventType1("ev-1"))
            await eventStore.append(new EventType2("ev-2"))
            await eventStore.append(new EventType2("ev-3"))
        })

        test("should return two events of type 'testEvent2' when read forward with event type filter", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(Query.fromItems([{ eventTypes: ["testEvent2"], tags: Tags.createEmpty() }]))
            )
            expect(events.length).toBe(2)
            expect(events[0].event.type).toBe("testEvent2")
            expect(events[1].event.type).toBe("testEvent2")
        })

        test("should treat multiple criteria as OR and return all events when read forward with multiple filters", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(
                    Query.fromItems([
                        { eventTypes: ["testEvent2"], tags: Tags.createEmpty() },
                        { eventTypes: ["testEvent1"], tags: Tags.createEmpty() }
                    ])
                )
            )
            expect(events.length).toBe(3)
        })

        test("should return respect limit clause when readAll forward", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all(), { limit: 1 }))
            expect(events.length).toBe(1)
            expect(events[0].event.type).toBe("testEvent1")
            expect(events[0].event.tags.equals(Tags.fromObj({ testTagKey: "ev-1" }))).toEqual(true)
        })

        test("should return respect limit clause when readAll backward", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all(), { limit: 1, backwards: true }))
            expect(events.length).toBe(1)
            expect(events[0].event.type).toBe("testEvent2")
            expect(events[0].event.tags.equals(Tags.fromObj({ testTagKey: "ev-3" }))).toEqual(true)
        })

        test("should return respect limit clause when read forward", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(Query.fromItems([{ eventTypes: ["testEvent2"], tags: Tags.createEmpty() }]), {
                    limit: 1
                })
            )

            expect(events.length).toBe(1)
            expect(events[0].event.type).toBe("testEvent2")
            expect(events[0].event.tags.equals(Tags.fromObj({ testTagKey: "ev-2" }))).toEqual(true)
        })

        test("should return respect limit clause when read backward", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(Query.fromItems([{ eventTypes: ["testEvent2"], tags: Tags.createEmpty() }]), {
                    limit: 1,
                    backwards: true
                })
            )
            expect(events.length).toBe(1)
            expect(events[0].event.type).toBe("testEvent2")
            expect(events[0].event.tags.equals(Tags.fromObj({ testTagKey: "ev-3" }))).toEqual(true)
        })

        test("should respect tag filter when 2 of the 3 events queried", async () => {
            const events = await streamAllEventsToArray(
                eventStore.read(
                    Query.fromItems([
                        {
                            eventTypes: ["testEvent1", "testEvent2", "testEvent2"],
                            tags: Tags.from(["testTagKey=ev-1", "testTagKey=ev-2"])
                        }
                    ])
                )
            )
            expect(events.length).toBe(2)
            expect(events[0].event.tags.values).toEqual(["testTagKey=ev-1"])
            expect(events[1].event.tags.values).toEqual(["testTagKey=ev-2"])
        })
    })

    test("should allow two consequtive reads in same transaction wihtout throwing", async () => {
        await eventStore.append(new EventType1())
        await eventStore.append(new EventType2())
        await streamAllEventsToArray(eventStore.read(Query.all()))
        await streamAllEventsToArray(eventStore.read(Query.all()))
    })
})
