import { SequencedEvent } from "../EventStore"
import { SequencePosition } from "../SequencePosition"
import { matchTags } from "../../eventHandling/matchTags"
import { QueryItem } from "../Query"

export const isInRange = (
    sequencePosition: SequencePosition,
    fromPosition: SequencePosition,
    backwards: boolean | undefined
) => (backwards ? !sequencePosition.isAfter(fromPosition) : !sequencePosition.isBefore(fromPosition))

export const deduplicateEvents = (events: SequencedEvent[]): SequencedEvent[] => {
    const uniqueEventsMap = new Map<string, SequencedEvent>()

    for (const event of events) {
        const key = event.position.toString()
        if (!uniqueEventsMap.has(key)) {
            uniqueEventsMap.set(key, event)
        }
    }

    return Array.from(uniqueEventsMap.values())
}

export const matchesQueryItem = (queryItem: QueryItem, { event }: SequencedEvent) => {
    if (queryItem.types && queryItem.types.length > 0 && !queryItem.types.includes(event.type)) return false

    return matchTags({ tagFilter: queryItem.tags, tags: event.tags })
}
