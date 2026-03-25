import { PositionDeserializer } from "@dcb-es/event-store"
import { PostgresPosition } from "./PostgresPosition"

export class PostgresPositionDeserializer implements PositionDeserializer {
    deserialize(raw: string) {
        return new PostgresPosition(parseInt(raw, 10))
    }
}
