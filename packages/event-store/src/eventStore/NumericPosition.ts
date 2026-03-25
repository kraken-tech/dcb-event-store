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
        return new NumericPosition(parseInt(raw, 10))
    }
}
