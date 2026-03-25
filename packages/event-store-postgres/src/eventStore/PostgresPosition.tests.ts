import { SequencePosition } from "@dcb-es/event-store"
import { PostgresPosition } from "./PostgresPosition"
import { PostgresPositionDeserializer } from "./PostgresPositionDeserializer"

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

describe("PostgresPosition", () => {
    describe("isAfter", () => {
        test("should return true when position is after other", () => {
            expect(new PostgresPosition(5).isAfter(new PostgresPosition(3))).toBe(true)
        })

        test("should return false when position is before other", () => {
            expect(new PostgresPosition(3).isAfter(new PostgresPosition(5))).toBe(false)
        })

        test("should return false when positions are equal", () => {
            expect(new PostgresPosition(5).isAfter(new PostgresPosition(5))).toBe(false)
        })
    })

    describe("isBefore", () => {
        test("should return true when position is before other", () => {
            expect(new PostgresPosition(3).isBefore(new PostgresPosition(5))).toBe(true)
        })

        test("should return false when position is after other", () => {
            expect(new PostgresPosition(5).isBefore(new PostgresPosition(3))).toBe(false)
        })

        test("should return false when positions are equal", () => {
            expect(new PostgresPosition(5).isBefore(new PostgresPosition(5))).toBe(false)
        })
    })

    describe("equals", () => {
        test("should return true for equal positions", () => {
            expect(new PostgresPosition(7).equals(new PostgresPosition(7))).toBe(true)
        })

        test("should return false for different positions", () => {
            expect(new PostgresPosition(7).equals(new PostgresPosition(8))).toBe(false)
        })
    })

    describe("instanceof guards", () => {
        const foreign = new ForeignPosition()

        test("isAfter throws when comparing with foreign position", () => {
            expect(() => new PostgresPosition(1).isAfter(foreign)).toThrow(
                "PostgresPosition can only be compared with PostgresPosition"
            )
        })

        test("isBefore throws when comparing with foreign position", () => {
            expect(() => new PostgresPosition(1).isBefore(foreign)).toThrow(
                "PostgresPosition can only be compared with PostgresPosition"
            )
        })

        test("equals throws when comparing with foreign position", () => {
            expect(() => new PostgresPosition(1).equals(foreign)).toThrow(
                "PostgresPosition can only be compared with PostgresPosition"
            )
        })
    })

    describe("toString", () => {
        test("should serialise to string representation", () => {
            expect(new PostgresPosition(42).toString()).toBe("42")
        })

        test("should serialise zero", () => {
            expect(new PostgresPosition(0).toString()).toBe("0")
        })
    })

    describe("PostgresPositionDeserializer", () => {
        const deserializer = new PostgresPositionDeserializer()

        test("should round-trip through toString and deserialize", () => {
            const original = new PostgresPosition(42)
            const restored = deserializer.deserialize(original.toString())
            expect(restored.equals(original)).toBe(true)
        })

        test("should round-trip zero", () => {
            const original = new PostgresPosition(0)
            const restored = deserializer.deserialize(original.toString())
            expect(restored.equals(original)).toBe(true)
        })
    })
})
