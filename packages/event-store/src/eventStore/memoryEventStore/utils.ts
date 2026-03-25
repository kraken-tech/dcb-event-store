import { SequencedEvent } from "../EventStore"
import { SequencePosition } from "../SequencePosition"
import { matchTags } from "../../eventHandling/matchTags"
import { QueryItem } from "../Query"

export const isInRange = (
    sequencePosition: SequencePosition,
    after: SequencePosition,
    backwards: boolean | undefined
) => (backwards ? sequencePosition.isBefore(after) : sequencePosition.isAfter(after))

export const matchesQueryItem = (queryItem: QueryItem, { event }: SequencedEvent) => {
    if (queryItem.types && queryItem.types.length > 0 && !queryItem.types.includes(event.type)) return false

    return matchTags({ tagFilter: queryItem.tags, tags: event.tags })
}
