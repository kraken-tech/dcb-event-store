import { SequencePosition } from "./SequencePosition"

export interface PositionDeserializer {
    deserialize(raw: string): SequencePosition
}
