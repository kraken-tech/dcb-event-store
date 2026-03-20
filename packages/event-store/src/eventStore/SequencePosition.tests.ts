import { SequencePosition } from "./SequencePosition"

describe("SequencePosition", () => {
    describe("initial", () => {
        test("should return a position", () => {
            expect(SequencePosition.initial()).toBeDefined()
        })

        test("should equal another initial position", () => {
            expect(SequencePosition.initial().equals(SequencePosition.initial())).toBe(true)
        })

        test("should be before any non-initial position", () => {
            expect(SequencePosition.initial().isBefore(SequencePosition.fromString("1"))).toBe(true)
        })

        test("should not be after any position", () => {
            expect(SequencePosition.initial().isAfter(SequencePosition.fromString("1"))).toBe(false)
        })

        test("should equal fromString('0')", () => {
            expect(SequencePosition.initial().equals(SequencePosition.fromString("0"))).toBe(true)
        })

        test("should serialize to '0'", () => {
            expect(SequencePosition.initial().toString()).toBe("0")
        })
    })

    describe("fromString / toString", () => {
        test("should round-trip a valid position", () => {
            const pos = SequencePosition.fromString("42")
            expect(pos.toString()).toBe("42")
        })

        test("should round-trip zero", () => {
            const pos = SequencePosition.fromString("0")
            expect(pos.toString()).toBe("0")
        })

        test("should throw on non-numeric string", () => {
            expect(() => SequencePosition.fromString("abc")).toThrow()
        })

        test("should throw on empty string", () => {
            expect(() => SequencePosition.fromString("")).toThrow()
        })

        test("should throw on negative number string", () => {
            expect(() => SequencePosition.fromString("-1")).toThrow()
        })

        test("should throw on decimal string", () => {
            expect(() => SequencePosition.fromString("1.5")).toThrow()
        })
    })

    describe("isAfter", () => {
        test("should return true when position is after other", () => {
            const a = SequencePosition.fromString("5")
            const b = SequencePosition.fromString("3")
            expect(a.isAfter(b)).toBe(true)
        })

        test("should return false when position is before other", () => {
            const a = SequencePosition.fromString("3")
            const b = SequencePosition.fromString("5")
            expect(a.isAfter(b)).toBe(false)
        })

        test("should return false when positions are equal", () => {
            const a = SequencePosition.fromString("5")
            const b = SequencePosition.fromString("5")
            expect(a.isAfter(b)).toBe(false)
        })
    })

    describe("isBefore", () => {
        test("should return true when position is before other", () => {
            const a = SequencePosition.fromString("3")
            const b = SequencePosition.fromString("5")
            expect(a.isBefore(b)).toBe(true)
        })

        test("should return false when position is after other", () => {
            const a = SequencePosition.fromString("5")
            const b = SequencePosition.fromString("3")
            expect(a.isBefore(b)).toBe(false)
        })

        test("should return false when positions are equal", () => {
            const a = SequencePosition.fromString("5")
            const b = SequencePosition.fromString("5")
            expect(a.isBefore(b)).toBe(false)
        })
    })

    describe("equals", () => {
        test("should return true for equal positions", () => {
            const a = SequencePosition.fromString("7")
            const b = SequencePosition.fromString("7")
            expect(a.equals(b)).toBe(true)
        })

        test("should return false for different positions", () => {
            const a = SequencePosition.fromString("7")
            const b = SequencePosition.fromString("8")
            expect(a.equals(b)).toBe(false)
        })
    })

    describe("compare", () => {
        test("should return -1 when a is before b", () => {
            const a = SequencePosition.fromString("3")
            const b = SequencePosition.fromString("5")
            expect(SequencePosition.compare(a, b)).toBe(-1)
        })

        test("should return 1 when a is after b", () => {
            const a = SequencePosition.fromString("5")
            const b = SequencePosition.fromString("3")
            expect(SequencePosition.compare(a, b)).toBe(1)
        })

        test("should return zero when positions are equal", () => {
            const a = SequencePosition.fromString("5")
            const b = SequencePosition.fromString("5")
            expect(SequencePosition.compare(a, b)).toBe(0)
        })

        test("should sort correctly with Array.sort", () => {
            const positions = [
                SequencePosition.fromString("3"),
                SequencePosition.fromString("1"),
                SequencePosition.fromString("2")
            ]
            positions.sort(SequencePosition.compare)
            expect(positions.map(p => p.toString())).toEqual(["1", "2", "3"])
        })
    })
})
