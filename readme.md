# Dynamic Consistency Boundary Event Store

A TypeScript/Node.js implementation of the [Dynamic Consistency Boundary (DCB)](https://dcb.events) pattern. DCBs are a technique for enforcing consistency in event-driven systems without relying on rigid transactional boundaries -- establishing consistency requirements dynamically at runtime rather than at design time.

Inspired by Sara Pellegrini's [Killing the Aggregate](https://sara.event-thinking.io/2023/04/kill-aggregate-chapter-1-I-am-here-to-kill-the-aggregate.html) blog series.

## Table of Contents

- [Packages](#packages)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
  - [EventStore](#eventstore)
  - [DcbEvent](#dcbevent)
  - [Tags](#tags)
  - [Query](#query)
  - [SequencePosition](#sequenceposition)
  - [EventHandlerWithState](#eventhandlerwithstate)
  - [EventHandler](#eventhandler)
  - [buildDecisionModel](#builddecisionmodel)
  - [MemoryEventStore](#memoryeventstore)
  - [streamAllEventsToArray](#stremalleventsttoarray)
  - [PostgresEventStore](#postgreseventstore)
  - [HandlerCatchup](#handlercatchup)
- [Usage Guide](#usage-guide)
  - [Defining Events](#defining-events)
  - [Defining Decision Models](#defining-decision-models)
  - [Handling Commands](#handling-commands)
  - [Projections with HandlerCatchup](#projections-with-handlercatchup)
- [Examples](#examples)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Packages

| Package | Description | Version |
|---------|-------------|---------|
| [`@dcb-es/event-store`](./packages/event-store) | Core event store interface, in-memory implementation, and event handling | 5.1.3 |
| [`@dcb-es/event-store-postgres`](./packages/event-store-postgres) | PostgreSQL-backed event store implementation | 6.2.1 |

## Prerequisites

- Node.js 18+
- TypeScript 5+
- PostgreSQL 14+ (for the Postgres implementation)
- Familiarity with event sourcing concepts
- Reading the [DCB specification and documentation](https://dcb.events) is strongly recommended

## Installation

```bash
# Core package (includes MemoryEventStore)
npm install @dcb-es/event-store

# PostgreSQL implementation
npm install @dcb-es/event-store-postgres
```

## Core Concepts

### The Problem DCBs Solve

Traditional event-sourced aggregates enforce consistency through partitioned event streams with optimistic version locking. This works until a business rule spans multiple entities -- for example, preventing a course from exceeding capacity while also limiting how many courses a student can join. With aggregates, you're forced into either a large aggregate, a saga, or accepting eventual consistency. Each option has significant trade-offs.

DCBs address this by replacing static boundaries with **dynamic** ones. Rather than locking on a stream version, you lock on a **query**: "fail this append if any events matching this query have been added since I last read." This is query-based optimistic locking.

### Tags

A **tag** is a reference to a unique instance of a concept involved in a domain integrity rule. Tags are key-value pairs attached to events (e.g., `courseId=math-101`, `studentId=stu-1`) that enable custom partitioning of the event stream without requiring separate streams per entity.

The precision of tag selection matters:
- **Too few tags** -- you miss events that could violate a business rule
- **Too many tags** -- you create unnecessary contention that blocks parallel processing

A single event can carry multiple tags, making it relevant to multiple consistency boundaries simultaneously. For example, a `StudentSubscribedToCourse` event tagged with both `courseId` and `studentId` is relevant to both course-capacity rules and per-student subscription-limit rules.

### Single Shared Event Stream

Rather than one stream per aggregate instance, DCBs use a **single event stream per bounded context**. Events are filtered by type and/or tags as needed. This eliminates the need to decide stream partitioning up front.

### Query-Based Optimistic Locking

When appending, you pass the same query used to read events along with the **Sequence Position** of the last event you were aware of. The store atomically checks: if any events matching that query exist after that position, the append fails. This guarantees you made your decision on a consistent view of the relevant events.

### Consistency Boundaries Are Dynamic

Because the consistency scope is defined by the query rather than a stream name, you can compose multiple projections with different tag filters into a single decision model. The resulting consistency boundary spans all of them -- covering exactly the events relevant to the business rules you are enforcing, no more and no less.

## API Reference

### EventStore

The core interface implemented by both `MemoryEventStore` and `PostgresEventStore`. Compliant with the [DCB specification](https://dcb.events/specification/).

```typescript
interface EventStore {
    append(events: DcbEvent | DcbEvent[], condition?: AppendCondition): Promise<void>
    read(query: Query, options?: ReadOptions): AsyncGenerator<EventEnvelope>
}
```

**`append`** -- Atomically persists one or more events. When an `AppendCondition` is provided, the store fails if any events matching the condition's query exist after the specified `expectedCeiling`. Throws on condition violation.

**`read`** -- Returns an async generator of **Sequenced Events** (called `EventEnvelope` here) matching the query, filtered by event type and/or tags.

```typescript
interface ReadOptions {
    backwards?: boolean                     // Read in reverse order
    fromSequencePosition?: SequencePosition // Start from this position
    limit?: number                          // Max events to return
}
```

### DcbEvent

The base interface for all domain events.

```typescript
interface DcbEvent<
    Tpe extends string = string,
    Tgs = Tags,
    Dta = unknown,
    Mtdta = unknown
> {
    type: Tpe       // Event type identifier
    tags: Tgs       // Tags referencing domain concepts involved in integrity rules
    data: Dta       // Event payload
    metadata: Mtdta // Optional metadata
}
```

### EventEnvelope

A **Sequenced Event** in DCB terminology -- an event combined with the Sequence Position assigned by the store during append.

```typescript
interface EventEnvelope<T extends DcbEvent = DcbEvent> {
    event: T
    timestamp: Timestamp
    sequencePosition: SequencePosition
}
```

### AppendCondition

Enforces consistency via query-based optimistic locking. The store fails the append if any events matching `query` exist after `expectedCeiling`.

```typescript
type AppendCondition = {
    query: Query                       // The query to check for conflicting events
    expectedCeiling: SequencePosition  // Ignore events at or before this position
}
```

This maps to the DCB spec concept of `failIfEventsMatch` (query) with an `after` position (`expectedCeiling`).

### Tags

Immutable key-value pairs that attach references to domain concepts to events. Tags enable precise, custom partitioning of the event stream for consistency enforcement and querying.

```typescript
// From an object (recommended)
const tags = Tags.fromObj({ courseId: "math-101", studentId: "stu-1" })
// Stored internally as ["courseId=math-101", "studentId=stu-1"]

// From raw strings
const tags = Tags.from(["courseId=math-101", "studentId=stu-1"])

// Empty tags (no partitioning)
const tags = Tags.createEmpty()

// Properties
tags.values             // string[] - the raw tag strings
tags.length             // number
tags.equals(otherTags)  // boolean
```

**Validation:** Each tag must match `key=value` where key and value are `[A-Za-z0-9-]+`. `fromObj` throws on empty objects.

### Query

Defines which events to read. A query is either "all events" or a set of `QueryItem` filters. Query Items are combined with **OR** logic; within a single item, type and tag criteria are combined with **AND** logic.

```typescript
// All events in the stream
const query = Query.all()

// Filtered query -- items are OR'd together
const query = Query.fromItems([
    { eventTypes: ["courseWasRegistered"], tags: Tags.fromObj({ courseId: "math-101" }) },
    { eventTypes: ["studentWasSubscribed"], tags: Tags.fromObj({ courseId: "math-101" }) }
])
```

```typescript
interface QueryItem {
    tags?: Tags           // Events must include all of these tags (subset match)
    eventTypes?: string[] // Events must be one of these types
}
```

An event with tags `[courseId=math-101, studentId=stu-1]` matches a filter of `[courseId=math-101]` -- the filter is a subset of the event's tags.

### SequencePosition

A unique, monotonically increasing identifier assigned to each event by the store during append. Gaps in the sequence are allowed. Supports numeric coercion for comparisons.

```typescript
const pos = SequencePosition.create(5)
const zero = SequencePosition.zero()

pos.value    // 5
pos.inc()    // SequencePosition(6)
pos.plus(3)  // SequencePosition(8)

// Numeric coercion works
pos > zero   // true
```

**Validation:** Must be a non-negative integer.

### Timestamp

An immutable ISO 8601 UTC timestamp assigned by the store during append.

```typescript
const now = Timestamp.now()
now.toISO  // "2024-01-15T10:30:00.000Z"

Timestamp.isValid("2024-01-15T10:30:00.000Z") // true
Timestamp.create("2024-01-15T10:30:00.000Z")  // Timestamp
```

### EventHandlerWithState

A projection used with `buildDecisionModel` to derive state from the event stream. Each handler defines which event types it handles, an optional tag filter to scope it to a specific entity instance, and a reducer function to accumulate state.

```typescript
interface EventHandlerWithState<TEvents extends DcbEvent, TState, TTags extends Tags = Tags> {
    tagFilter?: Partial<TTags>  // Scope to events referencing this domain concept instance
    onlyLastEvent?: boolean     // Declared in the interface but not currently used by buildDecisionModel
    init: TState                // Initial state before any events
    when: {
        [EventType]: (eventEnvelope: EventEnvelope, state: TState) => TState | Promise<TState>
    }
}
```

Example -- tracking course capacity across multiple event types:

```typescript
const CourseCapacity = (courseId: string): EventHandlerWithState<
    CourseWasRegistered | CourseCapacityWasChanged | StudentWasSubscribed | StudentWasUnsubscribed,
    { subscriberCount: number; capacity: number }
> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: { subscriberCount: 0, capacity: 0 },
    when: {
        courseWasRegistered: ({ event }) => ({
            capacity: event.data.capacity,
            subscriberCount: 0
        }),
        courseCapacityWasChanged: ({ event }, { subscriberCount }) => ({
            subscriberCount,
            capacity: event.data.newCapacity
        }),
        studentWasSubscribed: (_ev, { capacity, subscriberCount }) => ({
            subscriberCount: subscriberCount + 1,
            capacity
        }),
        studentWasUnsubscribed: (_ev, { capacity, subscriberCount }) => ({
            subscriberCount: subscriberCount - 1,
            capacity
        })
    }
})
```

### EventHandler

A stateless handler for projections and side effects -- used with `HandlerCatchup` to maintain read models asynchronously.

```typescript
interface EventHandler<TEvents extends DcbEvent, TTags extends Tags = Tags> {
    tagFilter?: Partial<TTags>
    onlyLastEvent?: boolean  // Declared in the interface but not currently used by HandlerCatchup
    when: {
        [EventType]: (eventEnvelope: EventEnvelope) => void | Promise<void>
    }
}
```

### buildDecisionModel

The core function for command handling. Reads all events relevant to the provided handlers, applies them to build state, and returns the accumulated state together with an `AppendCondition` ready for use in the subsequent append.

```typescript
import { buildDecisionModel } from "@dcb-es/event-store"

const { state, appendCondition } = await buildDecisionModel(eventStore, {
    courseExists:           CourseExists(courseId),
    courseCapacity:         CourseCapacity(courseId),
    studentAlreadySubscribed: StudentAlreadySubscribed({ courseId, studentId }),
    studentSubscriptions:   StudentSubscriptions(studentId)
})

// state keys match the handler names passed in
// state.courseExists            -> boolean
// state.courseCapacity          -> { subscriberCount: number, capacity: number }
// state.studentAlreadySubscribed -> boolean
// state.studentSubscriptions    -> { subscriptionCount: number }

await eventStore.append(newEvent, appendCondition)
```

**How it works:**

1. Collects each handler's event types and `tagFilter` into `QueryItem`s
2. Issues a single combined `Query` (items OR'd together) to the event store
3. For each Sequenced Event returned, routes it to every handler whose type and tag filter match
4. Tracks the highest `SequencePosition` seen across all events
5. Returns the final state map and an `AppendCondition` built from the combined query and that ceiling position

The consistency boundary is determined dynamically by the set of handlers passed in. Composing handlers that reference different entity instances (e.g., a course *and* a student) creates a cross-entity consistency boundary without any additional ceremony.

### MemoryEventStore

An in-memory implementation of `EventStore` for testing and prototyping.

```typescript
import { MemoryEventStore } from "@dcb-es/event-store"

const store = new MemoryEventStore()

// Pre-seed with existing Sequenced Events
const store = new MemoryEventStore(existingEventEnvelopes)

// Test helpers: register listeners for read/append calls
store.on("read", () => readCount++)
store.on("append", () => appendCount++)
```

### streamAllEventsToArray

A utility to drain an async generator from `read()` into an array. Useful in tests or when you need all events in memory at once.

```typescript
import { streamAllEventsToArray } from "@dcb-es/event-store"

const events = await streamAllEventsToArray(eventStore.read(Query.all()))
```

### PostgresEventStore

A PostgreSQL-backed event store. Appends require **serializable transaction isolation** to guarantee the atomicity of the append-condition check.

```typescript
import { PostgresEventStore } from "@dcb-es/event-store-postgres"
import { Pool } from "pg"

const pool = new Pool({ connectionString: "postgres://..." })
const eventStore = new PostgresEventStore(pool, {
    postgresTablePrefix: "myapp" // Optional: table will be named "myapp_events"
})

// Create the events table (idempotent, safe to call on every startup)
await eventStore.ensureInstalled()
```

**Appending requires a serializable transaction:**

```typescript
const client = await pool.connect()
try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE")
    const txEventStore = new PostgresEventStore(client)
    await txEventStore.append(events, appendCondition)
    await client.query("COMMIT")
} catch (e) {
    await client.query("ROLLBACK")
    throw e
} finally {
    client.release()
}
```

Reads use cursor-based streaming (batches of 100) so large event streams are memory-efficient.

### HandlerCatchup

Manages catchup of `EventHandler` projections against the PostgreSQL event store, with bookmark-based checkpointing to resume from the last processed position.

```typescript
import { HandlerCatchup } from "@dcb-es/event-store-postgres"

const catchup = new HandlerCatchup(pool, eventStore, "myapp") // table prefix is optional

// Create bookmark rows for each handler (idempotent)
await catchup.ensureInstalled(["courseProjection", "emailNotifier"])

// Process all unhandled events for each handler
await catchup.catchupHandlers({
    courseProjection: myCourseProjectionHandler,
    emailNotifier: myEmailHandler
})
```

On each `catchupHandlers` call:

1. Locks bookmark rows with `FOR UPDATE NOWAIT` -- fails immediately if another process holds the lock
2. For each handler, reads events from its last checkpoint to the current store head
3. Runs each Sequenced Event through the handler
4. Updates bookmarks and releases locks atomically

## Usage Guide

### Defining Events

Events implement `DcbEvent` with a literal string `type`, `tags` referencing the domain concepts involved in relevant integrity rules, a typed `data` payload, and optional `metadata`.

```typescript
import { DcbEvent, Tags } from "@dcb-es/event-store"

class CourseWasRegistered implements DcbEvent {
    type: "courseWasRegistered" = "courseWasRegistered"
    tags: Tags
    data: { courseId: string; title: string; capacity: number }
    metadata: unknown = {}

    constructor(params: { courseId: string; title: string; capacity: number }) {
        // Tag references the course concept -- events without this tag
        // are not relevant to course-level integrity rules
        this.tags = Tags.fromObj({ courseId: params.courseId })
        this.data = params
    }
}

class StudentWasSubscribed implements DcbEvent {
    type: "studentWasSubscribed" = "studentWasSubscribed"
    tags: Tags
    data: { courseId: string; studentId: string }
    metadata: unknown = {}

    constructor(params: { courseId: string; studentId: string }) {
        // Tagged with both courseId and studentId -- this event is relevant
        // to both course-capacity rules and per-student subscription-limit rules
        this.tags = Tags.fromObj({ courseId: params.courseId, studentId: params.studentId })
        this.data = params
    }
}
```

### Defining Decision Models

Decision models are projections -- factory functions returning `EventHandlerWithState` -- that reconstruct the minimal state required to validate a command's business rules.

```typescript
import { EventHandlerWithState, Tags } from "@dcb-es/event-store"

// Simple boolean check scoped to a single course
const CourseExists = (courseId: string): EventHandlerWithState<
    CourseWasRegistered,
    boolean
> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: false,
    when: {
        courseWasRegistered: () => true
    }
})

// Capacity tracking across multiple event types
const CourseCapacity = (courseId: string): EventHandlerWithState<
    CourseWasRegistered | CourseCapacityWasChanged | StudentWasSubscribed | StudentWasUnsubscribed,
    { subscriberCount: number; capacity: number }
> => ({
    tagFilter: Tags.fromObj({ courseId }),
    init: { subscriberCount: 0, capacity: 0 },
    when: {
        courseWasRegistered: ({ event }) => ({
            capacity: event.data.capacity,
            subscriberCount: 0
        }),
        courseCapacityWasChanged: ({ event }, { subscriberCount }) => ({
            subscriberCount,
            capacity: event.data.newCapacity
        }),
        studentWasSubscribed: (_ev, { capacity, subscriberCount }) => ({
            subscriberCount: subscriberCount + 1,
            capacity
        }),
        studentWasUnsubscribed: (_ev, { capacity, subscriberCount }) => ({
            subscriberCount: subscriberCount - 1,
            capacity
        })
    }
})

// onlyLastEvent is declared in the interface but not currently acted on by buildDecisionModel
const NextStudentNumber = (): EventHandlerWithState<StudentWasRegistered, number> => ({
    init: 1,
    onlyLastEvent: true,
    when: {
        studentWasRegistered: ({ event }) => event.data.studentNumber + 1
    }
})
```

### Handling Commands

Compose decision models with `buildDecisionModel`, enforce business rules against the derived state, and append events with the returned `appendCondition` to guarantee no conflicting events were added concurrently.

```typescript
import { buildDecisionModel, EventStore } from "@dcb-es/event-store"

async function subscribeStudentToCourse(
    eventStore: EventStore,
    cmd: { courseId: string; studentId: string }
) {
    const { courseId, studentId } = cmd

    // The decision model spans two entity instances (course + student),
    // forming a cross-entity consistency boundary dynamically
    const { state, appendCondition } = await buildDecisionModel(eventStore, {
        courseExists:             CourseExists(courseId),
        courseCapacity:           CourseCapacity(courseId),
        studentAlreadySubscribed: StudentAlreadySubscribed({ courseId, studentId }),
        studentSubscriptions:     StudentSubscriptions(studentId)
    })

    if (!state.courseExists)
        throw new Error(`Course ${courseId} doesn't exist.`)
    if (state.courseCapacity.subscriberCount >= state.courseCapacity.capacity)
        throw new Error(`Course ${courseId} is full.`)
    if (state.studentAlreadySubscribed)
        throw new Error(`Student ${studentId} is already subscribed.`)
    if (state.studentSubscriptions.subscriptionCount >= 5)
        throw new Error(`Student ${studentId} has reached the subscription limit.`)

    // appendCondition encodes: "fail if any relevant event was added since I read"
    await eventStore.append(
        new StudentWasSubscribed({ courseId, studentId }),
        appendCondition
    )
}
```

The `appendCondition` covers the combined query of all four handlers. If any conflicting event (e.g., another subscription to the same course, a capacity change) was appended concurrently, the append fails. The caller should catch the error and retry from the top.

### Projections with HandlerCatchup

Use `EventHandler` with `HandlerCatchup` to maintain read models, sending notifications, or any other side-effects driven by events.

```typescript
import { EventHandler } from "@dcb-es/event-store"
import { HandlerCatchup } from "@dcb-es/event-store-postgres"

const courseSubscriptionsProjection: EventHandler<
    StudentWasSubscribed | StudentWasUnsubscribed
> = {
    when: {
        studentWasSubscribed: async ({ event }) => {
            await db.query(
                "INSERT INTO course_subscriptions (course_id, student_id) VALUES ($1, $2)",
                [event.data.courseId, event.data.studentId]
            )
        },
        studentWasUnsubscribed: async ({ event }) => {
            await db.query(
                "DELETE FROM course_subscriptions WHERE course_id = $1 AND student_id = $2",
                [event.data.courseId, event.data.studentId]
            )
        }
    }
}

const catchup = new HandlerCatchup(pool, eventStore)
await catchup.ensureInstalled(["courseSubscriptions"])

// Call after each append, or on a schedule, to keep the read model current
await catchup.catchupHandlers({
    courseSubscriptions: courseSubscriptionsProjection
})
```

## Examples

The repository includes two example CLI applications in the [`examples/`](./examples) directory, both implementing the [course subscriptions](https://dcb.events/examples/course-subscriptions/) example from dcb.events:

### [course-manager-cli](./examples/course-manager-cli)

Demonstrates the core DCB pattern: registering courses and students, updating course capacity and titles, and subscribing/unsubscribing students. All state is derived on-the-fly from the event stream via `buildDecisionModel` -- there are no separate read models.

### [course-manager-cli-with-readmodel](./examples/course-manager-cli-with-readmodel)

Extends the above with a PostgreSQL-backed read model maintained by `HandlerCatchup` and `EventHandler` projections.

Both examples require a running PostgreSQL instance.

## Development

This is a Lerna monorepo using Yarn workspaces.

```bash
# Install dependencies
yarn install

# Build all packages
yarn build

# Run all tests
yarn test

# Run tests for a specific package
cd packages/event-store && yarn test

# Watch mode
yarn watch

# Lint
yarn lint
yarn lint-fix
```

The PostgreSQL package tests use [Testcontainers](https://node.testcontainers.org/) and require Docker.

## Contributing

Contributions are welcome via [issues](https://github.com/sennentech/dcb-event-sourced/issues), [pull requests](https://github.com/sennentech/dcb-event-sourced/pulls), or [discussions](https://github.com/sennentech/dcb-event-sourced/discussions).

## License

[MIT](./LICENSE.md) -- Copyright 2023 Paul Grimshaw
