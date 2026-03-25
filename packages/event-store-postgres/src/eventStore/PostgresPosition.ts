import { SequencePosition } from "@dcb-es/event-store"

export class PostgresPosition extends SequencePosition {
    constructor(readonly value: number) {
        super()
    }

    isAfter(other: SequencePosition): boolean {
        if (!(other instanceof PostgresPosition))
            throw new Error("PostgresPosition can only be compared with PostgresPosition")
        return this.value > other.value
    }

    isBefore(other: SequencePosition): boolean {
        if (!(other instanceof PostgresPosition))
            throw new Error("PostgresPosition can only be compared with PostgresPosition")
        return this.value < other.value
    }

    equals(other: SequencePosition): boolean {
        if (!(other instanceof PostgresPosition))
            throw new Error("PostgresPosition can only be compared with PostgresPosition")
        return this.value === other.value
    }

    toString(): string {
        return String(this.value)
    }

    static parse(raw: string): PostgresPosition {
        return new PostgresPosition(parseInt(raw, 10))
    }
}
