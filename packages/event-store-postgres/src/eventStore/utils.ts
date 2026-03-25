import { Tags, DcbEvent, SequencedEvent, Timestamp } from "@dcb-es/event-store"
import { PostgresPosition } from "./PostgresPosition"

export type DbWriteEvent = {
    type: string
    data: string
    metadata: string
    tags: string[]
}

export type DbReadEvent = {
    type: string
    data: unknown
    metadata: unknown
    tags: string[]
    timestamp: string
    sequence_position: string
}

export const dbEventConverter = {
    toDb: (dcbEvent: DcbEvent): DbWriteEvent => ({
        type: dcbEvent.type,
        data: JSON.stringify(dcbEvent.data),
        metadata: JSON.stringify(dcbEvent.metadata),
        tags: [...dcbEvent.tags.values]
    }),
    fromDb: (dbEvent: DbReadEvent): SequencedEvent => ({
        position: new PostgresPosition(parseInt(dbEvent.sequence_position)),
        timestamp: Timestamp.create(dbEvent.timestamp),
        event: {
            type: dbEvent.type,
            data: dbEvent.data,
            metadata: dbEvent.metadata,
            tags: Tags.from(dbEvent.tags)
        }
    })
}

export class ParamManager {
    public params: (string | string[] | number | boolean)[] = []
    add(paramValue: string | string[] | number | boolean): string {
        this.params.push(paramValue)
        return `$${this.params.length}`
    }
}
