export abstract class SequencePosition {
    abstract isAfter(other: SequencePosition): boolean
    abstract isBefore(other: SequencePosition): boolean
    abstract equals(other: SequencePosition): boolean
    abstract toString(): string
}
