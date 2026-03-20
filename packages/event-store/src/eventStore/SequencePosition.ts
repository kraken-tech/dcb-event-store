export class SequencePosition {
    #value: number

    private constructor(value: number) {
        this.#value = value
    }

    isAfter(other: SequencePosition): boolean {
        return this.#value > other.#value
    }

    isBefore(other: SequencePosition): boolean {
        return this.#value < other.#value
    }

    equals(other: SequencePosition): boolean {
        return this.#value === other.#value
    }

    toString(): string {
        return this.#value.toString()
    }

    static fromString(s: string): SequencePosition {
        const parsed = parseInt(s, 10)
        if (isNaN(parsed) || String(parsed) !== s) throw new Error(`Invalid position string: "${s}"`)
        if (parsed < 0) throw new Error("Sequence position must be >= 0")
        return new SequencePosition(parsed)
    }

    static compare(a: SequencePosition, b: SequencePosition): number {
        if (a.#value < b.#value) return -1
        if (a.#value > b.#value) return 1
        return 0
    }

    static initial(): SequencePosition {
        return new SequencePosition(0)
    }
}
