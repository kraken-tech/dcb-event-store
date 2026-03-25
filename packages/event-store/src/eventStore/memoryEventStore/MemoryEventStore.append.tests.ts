import { MemoryEventStore } from "./MemoryEventStore"
import { AppendCondition, DcbEvent } from "../EventStore"
import { AppendConditionError } from "../AppendConditionError"
import { SequencePosition } from "../SequencePosition"
import { streamAllEventsToArray } from "../streamAllEventsToArray"
import { Tags } from "../Tags"
import { Query } from "../Query"
class EventType1 implements DcbEvent {
    type: "testEvent1" = "testEvent1"
    tags: Tags
    data: Record<string, never>
    metadata: Record<string, never> = {}

    constructor(tagValue?: string) {
        this.tags = tagValue ? Tags.fromObj({ testTagKey: tagValue }) : Tags.from([])
        this.data = {}
    }
}

describe("memoryEventStore.append", () => {
    let eventStore: MemoryEventStore

    describe("when event store empty", () => {
        beforeEach(async () => {
            eventStore = new MemoryEventStore()
        })

        test("should return an empty array when no events are stored", async () => {
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            expect(events.length).toBe(0)
        })
        test("should assign a sequence number of 1 on appending the first event", async () => {
            await eventStore.append(new EventType1())
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            const lastSequencePosition = events.at(-1)?.position

            expect(lastSequencePosition?.toString()).toBe("1")
        })
        describe("when append condition with types filter and after provided", () => {
            const appendCondition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags: Tags.createEmpty() }]),
                after: SequencePosition.fromString("1")
            }
            test("should successfully append an event without throwing under specified conditions", async () => {
                await eventStore.append(new EventType1(), appendCondition)
                const events = await streamAllEventsToArray(eventStore.read(Query.all()))
                const lastSequencePosition = events.at(-1)?.position

                expect(lastSequencePosition?.toString()).toBe("1")
            })
        })
    })

    describe("when event store has exactly one event", () => {
        beforeEach(async () => {
            eventStore = new MemoryEventStore()
            await eventStore.append(new EventType1())
        })

        test("should increment sequence number to 2 when a second event is appended", async () => {
            await eventStore.append(new EventType1())
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            const lastSequencePosition = events.at(-1)?.position

            expect(lastSequencePosition?.toString()).toBe("2")
        })

        test("should update the sequence number to 3 after appending two more events", async () => {
            await eventStore.append([new EventType1(), new EventType1()])
            const events = await streamAllEventsToArray(eventStore.read(Query.all()))
            const lastSequencePosition = events.at(-1)?.position

            expect(lastSequencePosition?.toString()).toBe("3")
        })

        describe("when append condition with types filter and after provided", () => {
            const appendCondition: AppendCondition = {
                failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags: Tags.createEmpty() }]),
                after: SequencePosition.initial()
            }
            test("should throw an error if appended event exceeds the maximum allowed sequence number", async () => {
                await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(
                    "Expected Version fail: New events matching appendCondition found."
                )
            })

            test("should throw an AppendConditionError instance", async () => {
                await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(AppendConditionError)
            })

            test("should include the appendCondition in the thrown error", async () => {
                try {
                    await eventStore.append(new EventType1(), appendCondition)
                    fail("Expected AppendConditionError to be thrown")
                } catch (error) {
                    expect(error).toBeInstanceOf(AppendConditionError)
                    const appendError = error as AppendConditionError
                    expect(appendError.appendCondition).toBe(appendCondition)
                    expect(appendError.appendCondition.after).toBe(appendCondition.after)
                    expect(appendError.appendCondition.failIfEventsMatch).toBe(appendCondition.failIfEventsMatch)
                }
            })

            test("should have the correct error name", async () => {
                try {
                    await eventStore.append(new EventType1(), appendCondition)
                    fail("Expected AppendConditionError to be thrown")
                } catch (error) {
                    expect(error).toBeInstanceOf(AppendConditionError)
                    expect((error as AppendConditionError).name).toBe("AppendConditionError")
                }
            })

            test("should be catchable as an Error", async () => {
                try {
                    await eventStore.append(new EventType1(), appendCondition)
                    fail("Expected AppendConditionError to be thrown")
                } catch (error) {
                    expect(error).toBeInstanceOf(Error)
                    expect(error).toBeInstanceOf(AppendConditionError)
                }
            })
        })

        describe("when append condition with tag filter and maxSequencePosition provided", () => {
            test("should throw AppendConditionError when tag-filtered events exist beyond ceiling", async () => {
                const appendCondition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([
                        { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "tagA" }) }
                    ]),
                    after: SequencePosition.initial()
                }

                await eventStore.append(new EventType1("tagA"))

                await expect(eventStore.append(new EventType1("tagA"), appendCondition)).rejects.toThrow(
                    AppendConditionError
                )
            })

            test("should not throw when tag-filtered events do not match", async () => {
                const appendCondition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([
                        { types: ["testEvent1"], tags: Tags.fromObj({ testTagKey: "tagB" }) }
                    ]),
                    after: SequencePosition.initial()
                }

                await eventStore.append(new EventType1("tagA"))

                await expect(eventStore.append(new EventType1("tagA"), appendCondition)).resolves.not.toThrow()
            })
        })

        describe("when append condition with after omitted (undefined)", () => {
            test("should throw when matching events exist and after is undefined", async () => {
                const appendCondition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags: Tags.createEmpty() }])
                }
                await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(AppendConditionError)
            })

            test("should succeed when no matching events exist and after is undefined", async () => {
                const appendCondition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([{ types: ["nonExistentEvent"], tags: Tags.createEmpty() }])
                }
                await expect(eventStore.append(new EventType1(), appendCondition)).resolves.not.toThrow()
            })
        })

        describe("when append condition has multiple query items (OR semantics)", () => {
            test("should throw when any query item matches", async () => {
                const appendCondition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([
                        { types: ["nonExistentEvent"], tags: Tags.createEmpty() },
                        { types: ["testEvent1"], tags: Tags.createEmpty() }
                    ]),
                    after: SequencePosition.initial()
                }
                await expect(eventStore.append(new EventType1(), appendCondition)).rejects.toThrow(AppendConditionError)
            })

            test("should succeed when no query items match", async () => {
                const appendCondition: AppendCondition = {
                    failIfEventsMatch: Query.fromItems([
                        { types: ["nonExistentEvent1"], tags: Tags.createEmpty() },
                        { types: ["nonExistentEvent2"], tags: Tags.createEmpty() }
                    ]),
                    after: SequencePosition.initial()
                }
                await expect(eventStore.append(new EventType1(), appendCondition)).resolves.not.toThrow()
            })
        })


        describe("when no append condition is provided", () => {
            test("should not throw any error", async () => {
                await expect(eventStore.append(new EventType1())).resolves.not.toThrow()
            })
        })

        test("test append count works", async () => {
            let appendCount = 0
            eventStore.on("append", () => appendCount++)
            await eventStore.append(new EventType1())

            expect(appendCount).toBe(1)
        })
    })
})
