import { PositionDeserializer } from "./PositionDeserializer"
import { NumericPosition } from "./NumericPosition"

export class NumericPositionDeserializer implements PositionDeserializer {
    deserialize(raw: string) {
        return new NumericPosition(parseInt(raw, 10))
    }
}
