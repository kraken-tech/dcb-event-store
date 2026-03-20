import { buildDecisionModel } from "./buildDecisionModel"
import { CourseCapacity, CourseExists } from "./buildDecisionModel.tests.handlers"
import { CourseCapacityWasChangedEvent, CourseWasRegisteredEvent } from "./buildDecisionModel.tests.events"
import { MemoryEventStore } from "../eventStore/memoryEventStore/MemoryEventStore"
import { AppendCondition } from "../eventStore/EventStore"
import { Tags } from "../eventStore/Tags"
import { QueryItem } from "../eventStore/Query"

const COURSE_ID = "course-1"

describe("buildDecisionModel", () => {
    let eventStore: MemoryEventStore
    let appendCondition: AppendCondition

    beforeEach(() => {
        eventStore = new MemoryEventStore()
    })

    describe("when event store is empty", () => {
        describe("should handle default state for course exists eventHandler", () => {
            let courseExists: boolean

            beforeEach(async () => {
                const result = await buildDecisionModel(eventStore, {
                    courseExists: CourseExists(COURSE_ID)
                })
                courseExists = result.state.courseExists
                appendCondition = result.appendCondition
            })

            test("should indicate course does not exist", async () => {
                expect(courseExists).toBe(false)
            })

            test("should set the maximum sequence number to 0 in appendCondition", async () => {
                expect(appendCondition?.after.toString()).toBe("0")
            })

            test("should have a single event type of 'courseWasRegistered' in appendCondition", async () => {
                const { types } = <QueryItem>appendCondition.failIfEventsMatch.items[0]
                expect(types?.length).toBe(1)
                expect(types?.[0]).toBe("courseWasRegistered")
            })

            test("should include 'courseId' as a tag in appendCondition", async () => {
                const { tags } = <QueryItem>appendCondition.failIfEventsMatch.items[0]
                expect(Object.keys(tags ?? {}).length).toBe(1)
                expect(tags?.equals(Tags.fromObj({ courseId: "course-1" }))).toEqual(true)
            })
        })
    })

    describe("when event store contains 1 course created event", () => {
        let courseExists: boolean
        beforeEach(async () => {
            await eventStore.append(
                new CourseWasRegisteredEvent({
                    courseId: COURSE_ID,
                    capacity: 10
                })
            )

            const result = await buildDecisionModel(eventStore, {
                courseExists: CourseExists(COURSE_ID)
            })
            courseExists = result.state.courseExists
            appendCondition = result.appendCondition
        })

        test("should detect existing course via eventHandler", async () => {
            expect(courseExists).toBe(true)
        })

        test("should set the maximum sequence number to 1 in appendCondition", async () => {
            expect(appendCondition?.after.toString()).toBe("1")
        })

        test("should have a single event type of 'courseWasRegistered' in appendCondition", async () => {
            const { types } = <QueryItem>appendCondition.failIfEventsMatch.items[0]
            expect(types?.length).toBe(1)
            expect(types?.[0]).toBe("courseWasRegistered")
        })

        test("should include 'courseId' as a tag in appendCondition", async () => {
            const { tags } = <QueryItem>appendCondition.failIfEventsMatch.items[0]
            expect(Object.keys(tags ?? {}).length).toBe(1)
            expect(tags?.equals(Tags.fromObj({ courseId: "course-1" }))).toEqual(true)
        })
    })

    describe("when event store contains 1 course created event and 1 capacity changed event with CourseCapacity handler", () => {
        let courseCapacity: ReturnType<typeof CourseCapacity>["init"]
        beforeEach(async () => {
            await eventStore.append(
                new CourseWasRegisteredEvent({
                    courseId: COURSE_ID,
                    capacity: 10
                })
            )
            await eventStore.append(
                new CourseCapacityWasChangedEvent({
                    courseId: COURSE_ID,
                    newCapacity: 15
                })
            )
            const result = await buildDecisionModel(eventStore, {
                courseCapacity: CourseCapacity(COURSE_ID)
            })
            courseCapacity = result.state.courseCapacity
            appendCondition = result.appendCondition
        })

        test("should have assigned the new capacity of 15 to the course", async () => {
            expect(courseCapacity?.capacity).toBe(15)
        })

        test("should set the maximum sequence number to 2 in appendCondition", async () => {
            expect(appendCondition?.after.toString()).toBe("2")
        })

        test("should have the 4 correct event types in appendCondition", async () => {
            const { types } = <QueryItem>appendCondition.failIfEventsMatch.items[0]
            expect(types?.length).toBe(4)
            expect(
                [
                    "courseWasRegistered",
                    "courseCapacityWasChanged",
                    "studentWasUnsubscribed",
                    "studentWasSubscribed"
                ].sort()
            ).toEqual(expect.arrayContaining((types ?? []).sort()))
        })

        test("should include 'courseId' as a tag in appendCondition", async () => {
            const { tags } = <QueryItem>appendCondition.failIfEventsMatch.items[0]
            expect(Object.keys(tags ?? {}).length).toBe(1)
            expect(tags?.equals(Tags.fromObj({ courseId: "course-1" }))).toBe(true)
        })
    })

    describe("when event store contains 1 course created event and 1 capacity changed event with CourseCapacity and CourseExists handler", () => {
        let courseCapacity: ReturnType<typeof CourseCapacity>["init"]
        let courseExists: boolean
        beforeEach(async () => {
            await eventStore.append(
                new CourseWasRegisteredEvent({
                    courseId: COURSE_ID,
                    capacity: 10
                })
            )
            await eventStore.append(
                new CourseCapacityWasChangedEvent({
                    courseId: COURSE_ID,
                    newCapacity: 15
                })
            )
            const result = await buildDecisionModel(eventStore, {
                courseCapacity: CourseCapacity(COURSE_ID),
                courseExists: CourseExists(COURSE_ID)
            })
            courseCapacity = result.state.courseCapacity
            courseExists = result.state.courseExists
            appendCondition = result.appendCondition
        })

        test("should have assigned the new capacity of 15 to the course", async () => {
            expect(courseCapacity?.capacity).toBe(15)
        })

        test("should set the maximum sequence number to 2 in appendCondition", async () => {
            expect(appendCondition?.after.toString()).toBe("2")
        })

        test("should have the 4 correct event types in appendCondition", async () => {
            const { types } = <QueryItem>appendCondition.failIfEventsMatch.items[0]
            expect(types?.length).toBe(4)
            expect(
                [
                    "courseWasRegistered",
                    "courseCapacityWasChanged",
                    "studentWasUnsubscribed",
                    "studentWasSubscribed"
                ].sort()
            ).toEqual(expect.arrayContaining((types ?? []).sort()))
        })

        test("should include 'courseId' as a tag in appendCondition", async () => {
            const { tags } = <QueryItem>appendCondition.failIfEventsMatch.items[0]
            expect(Object.keys(tags ?? {}).length).toBe(1)
            expect(tags?.equals(Tags.fromObj({ courseId: "course-1" }))).toEqual(true)
        })

        test("should indicate course exists", async () => {
            expect(courseExists).toBe(true)
        })
    })
})
