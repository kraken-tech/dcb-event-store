---
title: "Opaque SequencePosition — Spec"
type: spec
feature: "opaque-sequence-position"
issue: 40
date_created: 2026-03-24
last_updated: 2026-03-25
status: complete
---

# Opaque SequencePosition

## Problem Statement

`SequencePosition` is a concrete class exposing numeric internals (`.value`, `.inc()`, `.plus()`, `Symbol.toPrimitive`). This leaks the Postgres adapter's `BIGSERIAL` representation into the core abstraction. Adapter-agnostic code (`buildDecisionModel`, `HandlerCatchup`) performs integer arithmetic on positions directly.

Any adapter not backed by a sequential integer (e.g. DynamoDB, issue #38) cannot implement the current type without pretending its positions are integers.

**Non-goals:**
- Removing numeric positions — `NumericPosition` remains the correct concrete type for integer-backed adapters. It becomes internal to each adapter.
- Changing observable behaviour — this is a pure refactoring.

---

## Goals & Constraints

**Functional goals:**
- `SequencePosition` is an abstract class: comparison (`isAfter`, `isBefore`, `equals`), serialisation (`toString`). No constructors, no arithmetic.
- Adapter-agnostic code can compare and serialise positions without knowing the concrete type.
- Each adapter owns its own concrete position class. No cross-adapter dependency.
- `AppendCondition.after` is optional per the [dcb.events spec](https://dcb.events/specification/). Omitting it means "fail if any matching event exists".
- Positions are serialisable via `toString()` (on the abstract class) and reconstructable via a static `parse` method on each concrete class.
- `ReadOptions.after` has exclusive semantics, consistent with `AppendCondition.after`.

**Constraints:**
- Breaking change to `@dcb-es/event-store` public API — semver major bump.
- Positions are totally ordered within a single store. Cross-store comparison is undefined.
- The abstract class must be subclassable by non-integer strategies (timestamps, ULIDs, DynamoDB cursors).

---

## Pattern Alignment

**Opaque abstract type.** Callers can compare and serialise positions but cannot construct them or perform arithmetic — those operations are internal to each adapter.

**Why an abstract class:** `EventStore` is a port. Projection catch-up handlers, API handlers answering "has the read model caught up?", `buildDecisionModel` — all adapter-agnostic code that needs comparison and serialisation without knowing the concrete type.

**Serialisation.** `toString()` on the abstract class for encoding (adapter-agnostic). Static `parse(raw)` on each concrete class for decoding (adapter-specific — the caller knows which adapter is in use at the composition root).

**Optional `after`.** Aligns with the [dcb.events spec](https://dcb.events/specification/), which states an append condition MAY contain an `after` position. `buildDecisionModel` starts with `after = undefined` and sets it as events are seen — no sentinel needed.

**Exclusive read semantics.** `after` means "events strictly after this position". The store handles +1 (or equivalent) internally.

---

## Design

### SequencePosition

```typescript
export abstract class SequencePosition {
    abstract isAfter(other: SequencePosition): boolean
    abstract isBefore(other: SequencePosition): boolean
    abstract equals(other: SequencePosition): boolean
    abstract toString(): string
}
```

### AppendCondition

```typescript
export type AppendCondition = {
    failIfEventsMatch: Query
    after?: SequencePosition
}
```

When present, the store checks only for matching events after that position. When omitted, the store checks against all matching events.

### ReadOptions

```typescript
export interface ReadOptions {
    backwards?: boolean
    after?: SequencePosition
    limit?: number
}
```

Exclusive semantics: the store returns events strictly after the given position.

### EventStore

```typescript
export interface EventStore {
    append(events: DcbEvent | DcbEvent[], condition?: AppendCondition): Promise<void>
    read(query: Query, options?: ReadOptions): AsyncGenerator<SequencedEvent>
}
```

### NumericPosition

Internal to each adapter. Not exported from `@dcb-es/event-store`.

```typescript
class NumericPosition extends SequencePosition {
    constructor(readonly value: number) {
        super()
    }

    isAfter(other: SequencePosition): boolean {
        if (!(other instanceof NumericPosition))
            throw new Error('NumericPosition can only be compared with NumericPosition')
        return this.value > other.value
    }

    isBefore(other: SequencePosition): boolean {
        if (!(other instanceof NumericPosition))
            throw new Error('NumericPosition can only be compared with NumericPosition')
        return this.value < other.value
    }

    equals(other: SequencePosition): boolean {
        if (!(other instanceof NumericPosition))
            throw new Error('NumericPosition can only be compared with NumericPosition')
        return this.value === other.value
    }

    toString(): string {
        return String(this.value)
    }

    static parse(raw: string): NumericPosition {
        return new NumericPosition(parseInt(raw, 10))
    }
}
```

The `instanceof` guard makes mixed-type comparison a loud failure. Arithmetic (`value + 1`) is performed on `.value` inside each adapter — not exposed through the abstract class. The static `parse` method handles deserialisation — callers at the composition root know which concrete class they're using.

The Postgres adapter defines its own structurally identical position class (`PostgresPosition`) with its own `parse`. This intentional duplication severs the cross-package dependency. See Alternatives Considered.

### Package Placement

| Class | Package | Exported? |
|---|---|---|
| `SequencePosition` | `@dcb-es/event-store` | Yes |
| `NumericPosition` | `@dcb-es/event-store` | No — internal to `MemoryEventStore` |
| `PostgresPosition` | `@dcb-es/event-store-postgres` | No — internal |

### buildDecisionModel

```
1. after = undefined
2. for each event in store.read(query):
3.   run handler, update state
4.   after = event.position
5. return { state, appendCondition: { failIfEventsMatch: query, after } }
```

`read` yields events in position order. Simple assignment tracks the last seen position — no comparison needed. If no events are read, `after` remains `undefined`.

### Append with Condition

When `after` is present, the adapter uses it to scope the check (e.g. `WHERE sequence_position > $N`). When `after` is `undefined`, the adapter checks all matching events.

### Projection Catch-Up with Frontend Polling

```
1. Command handler appends event, receives position
2. API returns position.toString() to frontend (e.g. "42")
3. Frontend polls: GET /readmodel?after=42
4. API parses: PostgresPosition.parse("42")
5. API checks: projection.currentPosition.isAfter(requestedPosition)
6. If true, return read model; otherwise wait/retry
```

### MemoryEventStore

Uses `NumericPosition` internally (same package). Arithmetic via `new NumericPosition(pos.value + 1)`. The `read` method converts `after` to an inclusive start internally. The `deduplicateEvents` helper keys by `.value` — a legitimate internal detail.

### PostgresEventStore

Constructs `PostgresPosition` from DB rows and extracts `.value` for SQL parameters. `after` maps directly to `WHERE sequence_position > $N`. `HandlerCatchup` uses `after` in read options and `isAfter` for ceiling checks — both via the abstract class.

---

## Alternatives Considered

**Export `NumericPosition` from core, share between adapters**
Rejected: recreates coupling. Any change to `NumericPosition` becomes a cross-package concern.

**Empty marker interface (no methods)**
Rejected: `EventStore` is a port. Projection catch-up and API handlers need comparison and serialisation without knowing the concrete type. A marker interface forces all position logic into adapter-specific code, violating the ports-and-adapters boundary.

**`next()` / `advance(delta)` on the abstract class**
Rejected: `after` with exclusive semantics eliminates the need. The store handles +1 internally. `advance(delta)` also exposes a numeric delta concept invalid for all position types.

**`toComparable(): number | string`**
Rejected: leaks the representation. Callers would treat the comparable value as meaningful, recreating coupling.

**`initialPosition` on `EventStore`**
Rejected: exists only to bootstrap `buildDecisionModel`. Optional `after` per the dcb.events spec is simpler and keeps the store interface minimal.

**Full codec pattern (encode + decode in one type)**
Rejected: encoding belongs on the position (`toString()`). A combined codec adds indirection for no benefit.

**Separate `PositionDeserializer` interface**
Rejected: overkill. The caller at the composition root already knows the concrete type, so a static `parse` method on the concrete class is simpler — no extra interface, no injection wiring.

**`parsePosition` on `EventStore`**
Rejected: deserialisation is not a store concern. A static `parse` on the concrete class is simpler and keeps the store interface minimal.

**`toString()` / `fromString()` both on the abstract class**
Rejected: `fromString` as a static on the abstract class can't know which subclass to construct. Static `parse` on each concrete class avoids this.

---

## Open Questions

1. **DynamoDB position type**: If DynamoDB also uses a sequential integer (`_SEQ` counter), should `NumericPosition` be promoted to a shared internal package? Deferred to #38 / #44.

2. **Cross-store position mixing**: A foreign position passed to a different store's `AppendCondition` would fail at the `instanceof` guard — loud, not silent. Whether this needs an explicit guard (e.g. `storeId` tag) is deferred until multiple stores coexist in one process.

---

## Component Design (LLD)

### Module structure

```
packages/event-store/
  src/eventStore/
    SequencePosition.ts              ← abstract class
    NumericPosition.ts               ← internal; NOT in index.ts; has static parse()
    EventStore.ts                    ← AppendCondition, ReadOptions, EventStore
    memoryEventStore/
      MemoryEventStore.ts

packages/event-store-postgres/
  src/eventStore/
    PostgresPosition.ts              ← internal; has static parse()
    PostgresEventStore.ts
    appendCommand.ts
    readSql.ts
    utils.ts
  src/eventHandling/
    HandlerCatchup.ts
```

### Key types

```typescript
// Public API
export abstract class SequencePosition {
    abstract isAfter(other: SequencePosition): boolean
    abstract isBefore(other: SequencePosition): boolean
    abstract equals(other: SequencePosition): boolean
    abstract toString(): string
}

export type AppendCondition = {
    failIfEventsMatch: Query
    after?: SequencePosition
}

export interface ReadOptions {
    backwards?: boolean
    after?: SequencePosition
    limit?: number
}

export interface EventStore {
    append(events: DcbEvent | DcbEvent[], condition?: AppendCondition): Promise<void>
    read(query: Query, options?: ReadOptions): AsyncGenerator<SequencedEvent>
}
```

### Implementation checklist

**`packages/event-store`**
- [ ] `SequencePosition.ts` — abstract class with `isAfter`, `isBefore`, `equals`, `toString`
- [ ] `NumericPosition.ts` — extends `SequencePosition`; `instanceof` guards; static `parse`; not in `index.ts`
- [ ] `EventStore.ts` — `AppendCondition.after` optional; `after` in `ReadOptions`
- [ ] `MemoryEventStore.ts` — `after` (exclusive); `after: undefined` in append
- [ ] `buildDecisionModel.ts` — `after` as `SequencePosition | undefined`
- [ ] `index.ts` — export `SequencePosition`

**`packages/event-store-postgres`**
- [ ] `PostgresPosition.ts` — new file; static `parse`
- [ ] `utils.ts` — construct `PostgresPosition`
- [ ] `PostgresEventStore.ts` — optional `after`; `after` in SQL
- [ ] `appendCommand.ts` — cast to `PostgresPosition`
- [ ] `readSql.ts` — `after` → `WHERE sequence_position > $N`
- [ ] `HandlerCatchup.ts` — `after`; `isAfter` via abstract class

**Tests**
- [ ] `NumericPosition` — comparison, toString, cross-type guard, parse round-trip
- [ ] `buildDecisionModel` — `after` undefined when no events
- [ ] All files — `fromPosition` → `after`; position assertions via `.equals()` / `.toString()`
