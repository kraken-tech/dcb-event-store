import { SequencePosition } from "./SequencePosition"

export class NumericPosition extends SequencePosition {
    constructor(readonly value: number) {
        super()
    }

    isAfter(other: SequencePosition): boolean {
        if (!(other instanceof NumericPosition))
            throw new Error("NumericPosition can only be compared with NumericPosition")
        return this.value > other.value
    }

    isBefore(other: SequencePosition): boolean {
        if (!(other instanceof NumericPosition))
            throw new Error("NumericPosition can only be compared with NumericPosition")
        return this.value < other.value
    }

    equals(other: SequencePosition): boolean {
        if (!(other instanceof NumericPosition))
            throw new Error("NumericPosition can only be compared with NumericPosition")
        return this.value === other.value
    }

    toString(): string {
        return String(this.value)
    }

    static parse(raw: string): NumericPosition {
        const value = parseInt(raw, 10)
        if (isNaN(value)) throw new Error(`Invalid position value: "${raw}"`)
        return new NumericPosition(value)
    }
}
