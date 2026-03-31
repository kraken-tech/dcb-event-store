import { NumericPosition } from "./NumericPosition"
import { SequencePosition } from "./SequencePosition"

class ForeignPosition extends SequencePosition {
    isAfter(): boolean {
        return false
    }
    isBefore(): boolean {
        return false
    }
    equals(): boolean {
        return false
    }
    toString(): string {
        return "foreign"
    }
}

describe("NumericPosition", () => {
    describe("initial position (0)", () => {
        test("should equal another zero position", () => {
            expect(new NumericPosition(0).equals(new NumericPosition(0))).toBe(true)
        })

        test("should be before any non-zero position", () => {
            expect(new NumericPosition(0).isBefore(new NumericPosition(1))).toBe(true)
        })

        test("should not be after any position", () => {
            expect(new NumericPosition(0).isAfter(new NumericPosition(1))).toBe(false)
        })
    })

    describe("isAfter", () => {
        test("should return true when position is after other", () => {
            expect(new NumericPosition(5).isAfter(new NumericPosition(3))).toBe(true)
        })

        test("should return false when position is before other", () => {
            expect(new NumericPosition(3).isAfter(new NumericPosition(5))).toBe(false)
        })

        test("should return false when positions are equal", () => {
            expect(new NumericPosition(5).isAfter(new NumericPosition(5))).toBe(false)
        })
    })

    describe("isBefore", () => {
        test("should return true when position is before other", () => {
            expect(new NumericPosition(3).isBefore(new NumericPosition(5))).toBe(true)
        })

        test("should return false when position is after other", () => {
            expect(new NumericPosition(5).isBefore(new NumericPosition(3))).toBe(false)
        })

        test("should return false when positions are equal", () => {
            expect(new NumericPosition(5).isBefore(new NumericPosition(5))).toBe(false)
        })
    })

    describe("equals", () => {
        test("should return true for equal positions", () => {
            expect(new NumericPosition(7).equals(new NumericPosition(7))).toBe(true)
        })

        test("should return false for different positions", () => {
            expect(new NumericPosition(7).equals(new NumericPosition(8))).toBe(false)
        })
    })

    describe("instanceof guards", () => {
        const foreign = new ForeignPosition()

        test("isAfter throws when comparing with foreign position", () => {
            expect(() => new NumericPosition(1).isAfter(foreign)).toThrow(
                "NumericPosition can only be compared with NumericPosition"
            )
        })

        test("isBefore throws when comparing with foreign position", () => {
            expect(() => new NumericPosition(1).isBefore(foreign)).toThrow(
                "NumericPosition can only be compared with NumericPosition"
            )
        })

        test("equals throws when comparing with foreign position", () => {
            expect(() => new NumericPosition(1).equals(foreign)).toThrow(
                "NumericPosition can only be compared with NumericPosition"
            )
        })
    })

    describe("toString", () => {
        test("should serialise to string representation", () => {
            expect(new NumericPosition(42).toString()).toBe("42")
        })

        test("should serialise zero", () => {
            expect(new NumericPosition(0).toString()).toBe("0")
        })
    })

    describe("parse", () => {
        test("should round-trip through toString and parse", () => {
            const original = new NumericPosition(42)
            const restored = NumericPosition.parse(original.toString())
            expect(restored.equals(original)).toBe(true)
        })

        test("should round-trip zero", () => {
            const original = new NumericPosition(0)
            const restored = NumericPosition.parse(original.toString())
            expect(restored.equals(original)).toBe(true)
        })

        test("should parse negative number string", () => {
            const pos = NumericPosition.parse("-5")
            expect(pos.value).toBe(-5)
        })

        test("should parse large number string", () => {
            const pos = NumericPosition.parse("9999999")
            expect(pos.value).toBe(9999999)
        })

        test("should throw for non-numeric string", () => {
            expect(() => NumericPosition.parse("abc")).toThrow('Invalid position value: "abc"')
        })

        test("should throw for empty string", () => {
            expect(() => NumericPosition.parse("")).toThrow('Invalid position value: ""')
        })

        test("should truncate decimal string to integer", () => {
            const pos = NumericPosition.parse("123.456")
            expect(pos.value).toBe(123)
        })
    })
})
