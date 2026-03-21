import {
    AppendCondition,
    AppendConditionError,
    DcbEvent,
    Query,
    SequencePosition,
    streamAllEventsToArray,
    Tags
} from "@dcb-es/event-store"
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb"
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

const createEventStore = async (): Promise<DynamoEventStore> => {
    const { client, tableName } = await getTestDynamoTable()
    return new DynamoEventStore(client, tableName)
}

const createEventStoreWithClient = async (): Promise<{ store: DynamoEventStore; client: DynamoDBDocumentClient; tableName: string }> => {
    const { client, tableName } = await getTestDynamoTable()
    return { store: new DynamoEventStore(client, tableName), client, tableName }
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

    describe("append with condition", () => {
        test("should succeed when no prior matching events exist", async () => {
            const eventStore = await createEventStore()
            const tags = Tags.from(["course=CS101"])

            const condition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags }]),
                after: SequencePosition.zero()
            }

            await eventStore.append(new EventType1(tags), condition)

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(1)
            expect(events[0].event.type).toBe("testEvent1")
        })

        test("should reject when matching events exceed last observed position", async () => {
            const eventStore = await createEventStore()
            const tags = Tags.from(["course=CS202"])

            // Append first event
            const condition1: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags }]),
                after: SequencePosition.zero()
            }
            await eventStore.append(new EventType1(tags), condition1)

            // Try to append with same condition at position 0 — should fail
            const condition2: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags }]),
                after: SequencePosition.zero()
            }
            await expect(eventStore.append(new EventType1(tags), condition2)).rejects.toThrow(
                AppendConditionError
            )
        })

        test("should succeed when unrelated events were appended (different type)", async () => {
            const eventStore = await createEventStore()
            const tags = Tags.from(["course=CS303"])

            // Append event of type 2
            await eventStore.append(new EventType2(tags))

            // Condition checks for type 1 only — should succeed
            const condition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags }]),
                after: SequencePosition.zero()
            }
            await eventStore.append(new EventType1(tags), condition)

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(2)
        })

        test("should succeed when unrelated events were appended (different tag)", async () => {
            const eventStore = await createEventStore()

            // Append event with tag A
            await eventStore.append(new EventType1(Tags.from(["course=CS404"])))

            // Condition checks tag B — should succeed
            const condition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags: Tags.from(["course=CS505"]) }]),
                after: SequencePosition.zero()
            }
            await eventStore.append(new EventType1(Tags.from(["course=CS505"])), condition)

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(2)
        })

        test("should succeed with condition after position of existing matching events", async () => {
            const eventStore = await createEventStore()
            const tags = Tags.from(["course=CS606"])

            // Append first event
            const condition1: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags }]),
                after: SequencePosition.zero()
            }
            await eventStore.append(new EventType1(tags), condition1)

            // Get the position of the first event
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            const lastPos = events[events.length - 1].position

            // Condition after the existing event's position — should succeed
            const condition2: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags }]),
                after: lastPos
            }
            await eventStore.append(new EventType1(tags), condition2)

            const allEvents = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(allEvents.length).toBe(2)
        })
    })

    describe("concurrency", () => {
        test("10 parallel same condition — exactly 1 wins", async () => {
            const eventStore = await createEventStore()
            const tags = Tags.from(["course=CONC1"])

            const condition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags }]),
                after: SequencePosition.zero()
            }

            const results = await Promise.allSettled(
                Array.from({ length: 10 }, () =>
                    eventStore.append(new EventType1(tags), condition)
                )
            )

            const succeeded = results.filter(r => r.status === "fulfilled")
            const failed = results.filter(r => r.status === "rejected")

            expect(succeeded.length).toBe(1)
            expect(failed.length).toBe(9)

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(1)
        }, 60_000)

        test("50 parallel different entities — all succeed", async () => {
            const eventStore = await createEventStore()

            const results = await Promise.allSettled(
                Array.from({ length: 50 }, (_, i) => {
                    const tags = Tags.from([`student=STU${i}`])
                    const condition: AppendCondition = {
                        failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags }]),
                        after: SequencePosition.zero()
                    }
                    return eventStore.append(new EventType1(tags), condition)
                })
            )

            const succeeded = results.filter(r => r.status === "fulfilled")
            expect(succeeded.length).toBe(50)

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(50)
        }, 60_000)

        test("100 parallel unconditional — all succeed", async () => {
            const eventStore = await createEventStore()

            const results = await Promise.allSettled(
                Array.from({ length: 100 }, (_, i) =>
                    eventStore.append(new EventType1(Tags.from([`batch=B${i}`])))
                )
            )

            const succeeded = results.filter(r => r.status === "fulfilled")
            expect(succeeded.length).toBe(100)

            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(100)
        }, 60_000)
    })

    describe("_COMMITTED_THROUGH watermark", () => {
        const getWatermark = async (client: DynamoDBDocumentClient, tableName: string): Promise<number | undefined> => {
            const result = await client.send(
                new GetCommand({
                    TableName: tableName,
                    Key: { PK: "_COMMITTED_THROUGH", SK: "_COMMITTED_THROUGH" },
                    ConsistentRead: true
                })
            )
            return result.Item?.value as number | undefined
        }

        test("should advance watermark on commit when no PENDING batches", async () => {
            const { store, client, tableName } = await createEventStoreWithClient()
            const tags = Tags.from(["wm=test1"])

            const condition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags }]),
                after: SequencePosition.zero()
            }
            await store.append(new EventType1(tags), condition)

            const watermark = await getWatermark(client, tableName)
            expect(watermark).toBeDefined()
            expect(watermark).toBeGreaterThan(0)
        })

        test("should only advance watermark forward (concurrent commits)", async () => {
            const { store, client, tableName } = await createEventStoreWithClient()

            // Append 5 events to different entities — all conditional
            await Promise.all(
                Array.from({ length: 5 }, (_, i) => {
                    const tags = Tags.from([`wm-conc=entity${i}`])
                    const condition: AppendCondition = {
                        failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags }]),
                        after: SequencePosition.zero()
                    }
                    return store.append(new EventType1(tags), condition)
                })
            )

            const watermark = await getWatermark(client, tableName)
            expect(watermark).toBeDefined()
            expect(watermark).toBeGreaterThan(0)

            // Watermark should be at or near the max sequence position
            const seqResult = await client.send(
                new GetCommand({
                    TableName: tableName,
                    Key: { PK: "_SEQ", SK: "_SEQ" },
                    ConsistentRead: true
                })
            )
            const maxSeq = seqResult.Item?.value as number
            expect(watermark).toBeLessThanOrEqual(maxSeq)
        })
    })
})
