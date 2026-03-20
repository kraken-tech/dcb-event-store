import { SequencedEvent, EventStore, AppendCondition, DcbEvent, ReadOptions } from "../EventStore"
import { AppendConditionError } from "../AppendConditionError"
import { SequencePosition } from "../SequencePosition"
import { Timestamp } from "../Timestamp"
import { isInRange, matchesQueryItem, deduplicateEvents } from "./utils"
import { Query } from "../Query"

const ensureIsArray = (events: DcbEvent | DcbEvent[]) => (Array.isArray(events) ? events : [events])

const nextPosition = (pos: SequencePosition) => SequencePosition.fromString(String(parseInt(pos.toString()) + 1))

const offsetPosition = (pos: SequencePosition, n: number) =>
    SequencePosition.fromString(String(parseInt(pos.toString()) + n))

const lastPosition = (events: SequencedEvent[]) =>
    events
        .map(event => event.position)
        .filter(pos => pos !== undefined)
        .pop() || SequencePosition.initial()

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

        const step = options?.backwards ? -1 : 1
        const maxPosition = lastPosition(this.events)
        const defaultPosition = options?.backwards ? maxPosition : SequencePosition.initial()
        let currentPosition = options?.fromPosition ?? defaultPosition
        let yieldedCount = 0

        const allMatchedEvents = !query.isAll
            ? query.items.flatMap((criterion, index) => {
                  const matchedEvents = this.events
                      .filter(
                          event =>
                              isInRange(event.position, currentPosition, options?.backwards) &&
                              matchesQueryItem(criterion, event)
                      )
                      .map(event => ({ ...event, matchedCriteria: [index.toString()] }))
                      .sort((a, b) => SequencePosition.compare(a.position, b.position))

                  return matchedEvents
              })
            : this.events.filter(ev => isInRange(ev.position, currentPosition, options?.backwards))

        const uniqueEvents = deduplicateEvents(allMatchedEvents).sort((a, b) =>
            options?.backwards
                ? SequencePosition.compare(b.position, a.position)
                : SequencePosition.compare(a.position, b.position)
        )

        for (const event of uniqueEvents) {
            yield event
            yieldedCount++
            if (options?.limit && yieldedCount >= options.limit) {
                break
            }
            currentPosition = offsetPosition(event.position, step)
        }
    }

    async append(events: DcbEvent | DcbEvent[], appendCondition?: AppendCondition): Promise<void> {
        if (this.testListenerRegistry.append) this.testListenerRegistry.append()
        const next = nextPosition(lastPosition(this.events))
        const sequencedEvents: Array<SequencedEvent> = ensureIsArray(events).map((ev, i) => ({
            event: ev,
            timestamp: Timestamp.now(),
            position: offsetPosition(next, i)
        }))

        if (appendCondition) {
            const { failIfEventsMatch, after } = appendCondition

            const matchingEvents = getMatchingEvents(failIfEventsMatch, after, this.events)

            if (matchingEvents.length > 0) throw new AppendConditionError(appendCondition)
        }

        this.events.push(...sequencedEvents)
    }
}

const getMatchingEvents = (query: Query, afterPosition: SequencePosition, events: SequencedEvent[]) => {
    const fromPosition = nextPosition(afterPosition)
    if (query.isAll) return events.filter(event => isInRange(event.position, fromPosition, false))

    return query.items.flatMap(queryItem =>
        events.filter(event => isInRange(event.position, fromPosition, false) && matchesQueryItem(queryItem, event))
    )
}
