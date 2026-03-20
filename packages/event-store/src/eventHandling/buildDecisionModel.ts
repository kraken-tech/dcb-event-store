import { AppendCondition, SequencedEvent, EventStore } from "../eventStore/EventStore"
import { Query, QueryItem } from "../eventStore/Query"
import { SequencePosition } from "../eventStore/SequencePosition"
import { Tags } from "../eventStore/Tags"
import { EventHandlerWithState } from "./EventHandlerWithState"
import { matchTags } from "./matchTags"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventHandlers = Record<string, EventHandlerWithState<any, any>>
type EventHandlerStates<T extends EventHandlers> = {
    [K in keyof T]: T[K]["init"]
}

export async function buildDecisionModel<T extends EventHandlers>(
    eventStore: EventStore,
    eventHandlers: T
): Promise<{ state: EventHandlerStates<T>; appendCondition: AppendCondition }> {
    const defaultHandler = (_: SequencedEvent, state: EventHandlerStates<T>) => state
    const states = Object.fromEntries(Object.entries(eventHandlers).map(([key, value]) => [key, value.init]))

    const queryItems: QueryItem[] = Object.values(eventHandlers).map(proj => ({
        tags: proj.tagFilter as Tags,
        types: Object.keys(proj.when) as string[]
    }))

    if (queryItems.length === 0) {
        throw new Error("Event handlers must have at least one event handler")
    }

    const failIfEventsMatch = Query.fromItems(queryItems)

    let after = SequencePosition.initial()
    for await (const sequencedEvent of eventStore.read(failIfEventsMatch)) {
        const { event, position } = sequencedEvent

        for (const [handlerId, eventHandler] of Object.entries(eventHandlers)) {
            const handlerIsRelevant =
                eventHandler.when[event.type] &&
                matchTags({ tags: event.tags, tagFilter: eventHandler.tagFilter as Tags })

            const handler = handlerIsRelevant ? eventHandler.when[event.type] : defaultHandler
            states[handlerId] = await handler(sequencedEvent, states[handlerId] as EventHandlerStates<T>)
        }
        if (position.isAfter(after)) after = position
    }

    return { state: states as EventHandlerStates<T>, appendCondition: { failIfEventsMatch, after } }
}
