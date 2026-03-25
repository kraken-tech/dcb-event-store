import { Query } from "./Query"
import { SequencePosition } from "./SequencePosition"
import { Tags } from "./Tags"
import { Timestamp } from "./Timestamp"

export interface DcbEvent<Tpe extends string = string, Tgs = Tags, Dta = unknown, Mtdta = unknown> {
    type: Tpe
    tags: Tgs
    data: Dta
    metadata: Mtdta
}

export interface SequencedEvent<T extends DcbEvent = DcbEvent> {
    event: T
    timestamp: Timestamp
    position: SequencePosition
}

export type AppendCondition = {
    failIfEventsMatch: Query
    after?: SequencePosition
}

export interface ReadOptions {
    backwards?: boolean
    afterPosition?: SequencePosition
    limit?: number
}

export interface EventStore {
    append: (events: DcbEvent | DcbEvent[], condition?: AppendCondition) => Promise<void>
    read: (query: Query, options?: ReadOptions) => AsyncGenerator<SequencedEvent>
}
