import { AppendConditionError } from "./AppendConditionError"
import { AppendCondition } from "./EventStore"
import { SequencePosition } from "./SequencePosition"
import { Query } from "./Query"
import { Tags } from "./Tags"

describe("AppendConditionError", () => {
    const createAppendCondition = (ceiling: string = "1"): AppendCondition => ({
        failIfEventsMatch: Query.fromItems([{ types: ["testEvent1"], tags: Tags.createEmpty() }]),
        after: SequencePosition.fromString(ceiling)
    })

    test("should be an instance of Error", () => {
        const error = new AppendConditionError(createAppendCondition())
        expect(error).toBeInstanceOf(Error)
    })

    test("should be an instance of AppendConditionError", () => {
        const error = new AppendConditionError(createAppendCondition())
        expect(error).toBeInstanceOf(AppendConditionError)
    })

    test("should have the correct error name", () => {
        const error = new AppendConditionError(createAppendCondition())
        expect(error.name).toBe("AppendConditionError")
    })

    test("should have the correct error message", () => {
        const error = new AppendConditionError(createAppendCondition())
        expect(error.message).toBe("Expected Version fail: New events matching appendCondition found.")
    })

    test("should expose the appendCondition", () => {
        const condition = createAppendCondition()
        const error = new AppendConditionError(condition)
        expect(error.appendCondition).toBe(condition)
    })

    test("should expose failIfEventsMatch from the appendCondition", () => {
        const condition = createAppendCondition()
        const error = new AppendConditionError(condition)
        expect(error.appendCondition.failIfEventsMatch).toBe(condition.failIfEventsMatch)
    })

    test("should expose after from the appendCondition", () => {
        const condition = createAppendCondition("5")
        const error = new AppendConditionError(condition)
        expect(error.appendCondition.after.toString()).toBe("5")
    })

    test("should have a stack trace", () => {
        const error = new AppendConditionError(createAppendCondition())
        expect(error.stack).toBeDefined()
        expect(error.stack).toContain("AppendConditionError")
    })

    test("should be distinguishable from generic Error via instanceof", () => {
        const appendError = new AppendConditionError(createAppendCondition())
        const genericError = new Error("some other error")

        expect(appendError instanceof AppendConditionError).toBe(true)
        expect(genericError instanceof AppendConditionError).toBe(false)
    })

    test("should be catchable in a try-catch and identifiable", () => {
        try {
            throw new AppendConditionError(createAppendCondition())
        } catch (error) {
            if (error instanceof AppendConditionError) {
                expect(error.appendCondition).toBeDefined()
            } else {
                fail("Expected error to be an instance of AppendConditionError")
            }
        }
    })

    test("should work with Promise.reject", async () => {
        const condition = createAppendCondition()
        const promise = Promise.reject(new AppendConditionError(condition))

        await expect(promise).rejects.toThrow(AppendConditionError)
        await expect(Promise.reject(new AppendConditionError(condition))).rejects.toThrow(
            "Expected Version fail: New events matching appendCondition found."
        )
    })

    test("should preserve appendCondition with Query.all()", () => {
        const condition: AppendCondition = {
            failIfEventsMatch: Query.all(),
            after: SequencePosition.fromString("10")
        }
        const error = new AppendConditionError(condition)
        expect(error.appendCondition.failIfEventsMatch.isAll).toBe(true)
        expect(error.appendCondition.after.toString()).toBe("10")
    })
})
