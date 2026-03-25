import { SequencedEvent, EventStore, AppendCondition, DcbEvent, ReadOptions } from "../EventStore"
import { AppendConditionError } from "../AppendConditionError"
import { NumericPosition } from "../NumericPosition"
import { SequencePosition } from "../SequencePosition"
import { Timestamp } from "../Timestamp"
import { isInRange, matchesQueryItem } from "./utils"
import { Query } from "../Query"

const ensureIsArray = (events: DcbEvent | DcbEvent[]) => (Array.isArray(events) ? events : [events])

const asNumeric = (pos: SequencePosition) => (pos as NumericPosition).value

const lastPosition = (events: SequencedEvent[]) =>
    events
        .map(event => event.position)
        .filter(pos => pos !== undefined)
        .pop() || new NumericPosition(0)

const deduplicateEvents = (events: SequencedEvent[]): SequencedEvent[] => {
    const seen = new Map<number, SequencedEvent>()
    for (const event of events) {
        const key = asNumeric(event.position)
        if (!seen.has(key)) seen.set(key, event)
    }
    return Array.from(seen.values())
}

const byPosition = (a: SequencedEvent, b: SequencedEvent) => asNumeric(a.position) - asNumeric(b.position)

const byPositionDesc = (a: SequencedEvent, b: SequencedEvent) => asNumeric(b.position) - asNumeric(a.position)

export class MemoryEventStore implements EventStore {
    private testListenerRegistry: { read: () => void; append: () => void } = {
        read: () => null,
        append: () => null
    }

    private events: Array<SequencedEvent> = []

    constructor(initialEvents: Array<SequencedEvent> = []) {
        this.events = [...initialEvents]
    }

    public on(ev: "read" | "append", fn: () => void) {
        this.testListenerRegistry[ev] = fn
    }

    async *read(query: Query, options?: ReadOptions): AsyncGenerator<SequencedEvent> {
        if (this.testListenerRegistry.read) this.testListenerRegistry.read()

        let yieldedCount = 0

        const filterByPosition = (event: SequencedEvent): boolean => {
            if (!options?.after) return true
            return isInRange(event.position, options.after, options?.backwards)
        }

        const allMatchedEvents = !query.isAll
            ? query.items.flatMap((criterion, index) =>
                  this.events
                      .filter(event => filterByPosition(event) && matchesQueryItem(criterion, event))
                      .map(event => ({ ...event, matchedCriteria: [index.toString()] }))
                      .sort(byPosition)
              )
            : this.events.filter(filterByPosition)

        const uniqueEvents = deduplicateEvents(allMatchedEvents).sort(options?.backwards ? byPositionDesc : byPosition)

        for (const event of uniqueEvents) {
            yield event
            yieldedCount++
            if (options?.limit && yieldedCount >= options.limit) {
                break
            }
        }
    }

    async append(events: DcbEvent | DcbEvent[], appendCondition?: AppendCondition): Promise<void> {
        if (this.testListenerRegistry.append) this.testListenerRegistry.append()
        const nextValue = asNumeric(lastPosition(this.events)) + 1
        const sequencedEvents: Array<SequencedEvent> = ensureIsArray(events).map((ev, i) => ({
            event: ev,
            timestamp: Timestamp.now(),
            position: new NumericPosition(nextValue + i)
        }))

        if (appendCondition) {
            const { failIfEventsMatch, after } = appendCondition
            const matchingEvents = getMatchingEvents(failIfEventsMatch, after, this.events)
            if (matchingEvents.length > 0) throw new AppendConditionError(appendCondition)
        }

        this.events.push(...sequencedEvents)
    }
}

const getMatchingEvents = (query: Query, after: SequencePosition | undefined, events: SequencedEvent[]) => {
    const filterByPosition = (event: SequencedEvent): boolean => {
        if (!after) return true
        return event.position.isAfter(after)
    }

    if (query.isAll) return events.filter(filterByPosition)

    return query.items.flatMap(queryItem =>
        events.filter(event => filterByPosition(event) && matchesQueryItem(queryItem, event))
    )
}
