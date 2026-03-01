import { Pool, PoolClient } from "pg"
import { AppendCondition, DcbEvent, Query, SequencePosition, streamAllEventsToArray, Tags } from "@dcb-es/event-store"
import { PostgresEventStore } from "./PostgresEventStore"
import { getTestPgDatabasePool } from "@test/testPgDbPool"

class EventType1 implements DcbEvent {
    type: "testEvent1" = "testEvent1"
    tags: Tags
    data: Record<string, never>
    metadata: { userId: string } = { userId: "user-1" }

    constructor(tags: Tags = Tags.createEmpty()) {
        this.tags = tags
        this.data = {}
    }
}

class EventType2 implements DcbEvent {
    type: "testEvent2" = "testEvent2"
    tags: Tags
    data: Record<string, never>
    metadata: { userId: string } = { userId: "user-1" }

    constructor(tags: Tags = Tags.createEmpty()) {
        this.tags = tags
        this.data = {}
    }
}

describe("postgresEventStore.append", () => {
    let pool: Pool
    let client: PoolClient
    let eventStore: PostgresEventStore

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 100 })
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

    describe("when event store empty", () => {
        test("should return an empty array when no events are stored", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(0)
        })
        test("should assign a sequence number of 1 on appending the first event", async () => {
            await eventStore.append(new EventType1())
            const lastSequencePosition = (await streamAllEventsToArray(eventStore.read(Query.all()))).at(
                -1
            )?.sequencePosition
            expect(lastSequencePosition?.value).toBe(1)
        })
        describe("when append condition with eventTypes filter and expectedCeiling provided", () => {
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ eventTypes: ["testEvent1"], tags: Tags.createEmpty() }]),
                expectedCeiling: SequencePosition.create(1)
            }
            test("should successfully append an event without throwing under specified conditions", async () => {
                await eventStore.append(new EventType1(), appendCondition)
                const lastSequencePosition = (await streamAllEventsToArray(eventStore.read(Query.all()))).at(
                    -1
                )?.sequencePosition
                expect(lastSequencePosition?.value).toBe(1)
            })

            test("should store and return metadata on event successfully", async () => {
                await eventStore.append(new EventType1())
                const events = await streamAllEventsToArray(eventStore.read(Query.all()))
                const lastEvent = events.at(-1)?.event as EventType1
                expect(lastEvent.metadata.userId).toBe("user-1")
            })
        })
    })

    describe("when event store has exactly one event", () => {
        beforeEach(async () => {
            await eventStore.append(new EventType1())
        })

        test("should increment sequence number to 2 when a second event is appended", async () => {
            await eventStore.append(new EventType1())
            const lastSequencePosition = (await streamAllEventsToArray(eventStore.read(Query.all()))).at(
                -1
            )?.sequencePosition
            expect(lastSequencePosition?.value).toBe(2)
        })

        test("should update the sequence number to 3 after appending two more events", async () => {
            await eventStore.append([new EventType1(), new EventType1()])
            const lastSequencePosition = (await streamAllEventsToArray(eventStore.read(Query.all()))).at(
                -1
            )?.sequencePosition

            expect(lastSequencePosition?.value).toBe(3)
        })

        describe("when append condition with eventTypes filter and expectedCeiling provided", () => {
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ eventTypes: ["testEvent1"], tags: Tags.createEmpty() }]),
                expectedCeiling: SequencePosition.zero()
            }
            test("should throw an error if appended event exceeds the maximum allowed sequence number", async () => {
                await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(
                    "Expected Version fail: New events matching appendCondition found."
                )
            })
        })

        test("should concurrently add a single event rejecting rest when lots attempted in parallel with same append condition", async () => {
            const storeEvents = []

            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ eventTypes: ["testEvent1"] }]),
                expectedCeiling: SequencePosition.create(1)
            }

            for (let i = 0; i < 10; i++) {
                storeEvents.push(eventStore.append(new EventType1(), appendCondition))
            }
            const results = await Promise.allSettled(storeEvents)
            expect(results.filter(r => r.status === "fulfilled").length).toBe(1)
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(2)
        })

        test("should concurrently add a all events when lots attempted in parralel", async () => {
            const storeEvents = []
            const iterations = 1000
            for (let i = 0; i < iterations; i++) {
                storeEvents.push(eventStore.append(new EventType1()))
            }
            const results = await Promise.allSettled(storeEvents)
            expect(results.filter(r => r.status === "fulfilled").length).toBe(iterations)
        })

        test("should fail to append next event if append condition is no longer met", async () => {
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ eventTypes: ["testEvent1"], tags: Tags.createEmpty() }]),
                expectedCeiling: SequencePosition.create(1)
            }

            // First append should pass and set sequence_position to 2
            await eventStore.append(new EventType1(), appendCondition)
            await eventStore.append(new EventType2())

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.at(-2)?.sequencePosition?.value).toBe(2)

            // Second append should pass and as its unrelated (different event type)
            expect(events.at(-1)?.sequencePosition?.value).toBe(3)

            // Third append with the same condition should fail because it would exceed expectedCeiling=2
            await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(
                "Expected Version fail: New events matching appendCondition found."
            )
        })
    })

    describe("when append condition uses Query.all()", () => {
        test("should successfully append when no prior events exist", async () => {
            const appendCondition: AppendCondition = {
                query: Query.all(),
                expectedCeiling: SequencePosition.create(0)
            }
            await eventStore.append(new EventType1(Tags.from(["some=tag"])), appendCondition)
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(1)
        })

        test("should reject append when prior events exceed expectedCeiling", async () => {
            await eventStore.append(new EventType1())
            const appendCondition: AppendCondition = {
                query: Query.all(),
                expectedCeiling: SequencePosition.create(0)
            }
            await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(
                "Expected Version fail: New events matching appendCondition found."
            )
        })

        test("should successfully append when prior events are within expectedCeiling", async () => {
            await eventStore.append(new EventType1())
            const appendCondition: AppendCondition = {
                query: Query.all(),
                expectedCeiling: SequencePosition.create(1)
            }
            await eventStore.append(new EventType2(), appendCondition)
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(2)
        })
    })

    describe("when append condition uses tag-only query (no eventTypes)", () => {
        test("should successfully append when no prior events match the tag filter", async () => {
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ tags: Tags.from(["some=tag"]) }]),
                expectedCeiling: SequencePosition.create(0)
            }
            await eventStore.append(new EventType1(Tags.from(["some=tag"])), appendCondition)
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(1)
        })

        test("should reject append when prior events with matching tags exceed expectedCeiling", async () => {
            await eventStore.append(new EventType1(Tags.from(["some=tag"])))
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ tags: Tags.from(["some=tag"]) }]),
                expectedCeiling: SequencePosition.create(0)
            }
            await expect(eventStore.append(new EventType1(Tags.from(["some=tag"])), appendCondition)).rejects.toThrow(
                "Expected Version fail: New events matching appendCondition found."
            )
        })

        test("should successfully append when prior events have different tags", async () => {
            await eventStore.append(new EventType1(Tags.from(["other=tag"])))
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ tags: Tags.from(["some=tag"]) }]),
                expectedCeiling: SequencePosition.create(0)
            }
            await eventStore.append(new EventType1(Tags.from(["some=tag"])), appendCondition)
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(2)
        })

        test("should successfully append with empty tags in query item", async () => {
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ tags: Tags.createEmpty() }]),
                expectedCeiling: SequencePosition.create(0)
            }
            await eventStore.append(new EventType1(), appendCondition)
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(1)
        })

        test("should successfully append with explicit empty eventTypes array and tags", async () => {
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ eventTypes: [], tags: Tags.from(["some=tag"]) }]),
                expectedCeiling: SequencePosition.create(0)
            }
            await eventStore.append(new EventType1(Tags.from(["some=tag"])), appendCondition)
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(1)
        })

        test("should handle multiple tag-only query items as OR conditions", async () => {
            await eventStore.append(new EventType1(Tags.from(["tag1=val1"])))
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ tags: Tags.from(["tag1=val1"]) }, { tags: Tags.from(["tag2=val2"]) }]),
                expectedCeiling: SequencePosition.create(0)
            }
            await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(
                "Expected Version fail: New events matching appendCondition found."
            )
        })
    })

    describe("when append condition uses mixed query items", () => {
        test("should handle a mix of eventType-only and tag-only query items", async () => {
            await eventStore.append(new EventType1(Tags.from(["some=tag"])))
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ eventTypes: ["testEvent2"] }, { tags: Tags.from(["some=tag"]) }]),
                expectedCeiling: SequencePosition.create(0)
            }
            await expect(eventStore.append(new EventType2(), appendCondition)).rejects.toThrow(
                "Expected Version fail: New events matching appendCondition found."
            )
        })

        test("should succeed when mixed query items find no matching events beyond ceiling", async () => {
            await eventStore.append(new EventType1(Tags.from(["some=tag"])))
            const appendCondition: AppendCondition = {
                query: Query.fromItems([{ eventTypes: ["testEvent2"] }, { tags: Tags.from(["other=tag"]) }]),
                expectedCeiling: SequencePosition.create(0)
            }
            await eventStore.append(new EventType2(), appendCondition)
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(2)
        })
    })

    test("should throw error if given a transaction that is not at isolation level serializable (READ COMMITTED)", async () => {
        const client = await pool.connect()
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED")
        const eventStore = new PostgresEventStore(client)
        await expect(eventStore.append(new EventType1())).rejects.toThrow("Transaction is not serializable")
        await client.query("ROLLBACK")
        client.release()
    })

    test("should throw error if given a transaction that is not at isolation level serializable (default level)", async () => {
        const client = await pool.connect()
        await client.query("BEGIN TRANSACTION")
        const eventStore = new PostgresEventStore(client)
        await expect(eventStore.append(new EventType1())).rejects.toThrow("Transaction is not serializable")
        await client.query("ROLLBACK")
        client.release()
    })

    test("should throw error if transaction is not started", async () => {
        const client = await pool.connect()
        const eventStore = new PostgresEventStore(client)
        await expect(eventStore.append(new EventType1())).rejects.toThrow("Transaction is not serializable")
        client.release()
    })

    test("should use prefixed table name when provided", async () => {
        const client = await pool.connect()

        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        const eventStore = new PostgresEventStore(client, { postgresTablePrefix: "prefix" })

        await eventStore.ensureInstalled()
        await eventStore.append(new EventType1())

        const events = await streamAllEventsToArray(eventStore.read(Query.all()))
        const directRows = await client.query("select * from prefix_events")
        expect(directRows.rows.length).toBe(1)
        expect(events.length).toBe(1)
        await client.query("ROLLBACK")
        client.release()
    })
})
