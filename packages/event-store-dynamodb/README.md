# @dcb-es/event-store-dynamodb

DynamoDB implementation of the `EventStore` interface from `@dcb-es/event-store`.

## Design Goals

- Full [DCB compliance](https://dcb.events): append conditions that reject writes when new matching events have been added since the caller last read
- No artificial batch size limits — handle 1 event or 100,000+ events transparently
- Fine-grained concurrency — unrelated writes never conflict
- Crash-safe — partial failures never produce visible corrupt state

## Adapter Constraints

This adapter enforces two constraints beyond the base `EventStore` interface. These are specific to the DynamoDB implementation and enable the fine-grained lock system that gives maximum write parallelism.

1. **Every event must have at least one tag.**
2. **Every `QueryItem` in an `AppendCondition` must have non-empty `eventTypes` AND non-empty `tags`.**

These constraints mean the adapter only needs `(eventType, tagValue)` pair locks — no type-level, tag-level, or global locks. Two writers only conflict if they share an exact (type, tag) pair, giving the finest possible granularity.

If your domain requires a type-level constraint (e.g. "count all CourseCreated events for the next course number"), model it with an explicit tag that represents the consistency boundary:

```typescript
// Every CourseCreated event carries:
{ type: "CourseCreated", tags: Tags.from(["course=CS101", "courseIndex=global"]) }

// Append condition:
{
  query: Query.fromItems([{ eventTypes: ["CourseCreated"], tags: Tags.from(["courseIndex=global"]) }]),
  expectedCeiling: lastObservedPosition
}

// Lock: _LOCK#CourseCreated:courseIndex=global
// Serializes all course creation — which is the real domain constraint.
// Does not affect StudentEnrolled, CourseUpdated, or any other event type.
```

**Reads are unrestricted.** `Query.all()`, type-only queries, and tag-only queries all work for reads and projections. The constraints only apply to append conditions.

```typescript
// All valid reads:
eventStore.read(Query.all())                                                // full catch-up
eventStore.read(Query.all(), { fromSequencePosition: pos })                 // resume projection
eventStore.read(Query.fromItems([{ eventTypes: ["CourseCreated"] }]))        // type-only read
eventStore.read(Query.fromItems([{ tags: Tags.from(["course=CS101"]) }]))   // tag-only read

// Appending without a condition — no constraints, no locks:
eventStore.append(events)
```

## Architecture Overview

### Consistency Strategy: Lease-Based Pessimistic Locks

DynamoDB lacks Postgres's `SERIALIZABLE` isolation and SQL subqueries. Instead, we use:

1. **Fine-grained pessimistic locks** on `(eventType, tagValue)` pairs for mutual exclusion
2. **Lease-based lock lifecycle** with heartbeats (following the [AWS DynamoDB Lock Client](https://aws.amazon.com/blogs/database/building-distributed-locks-with-the-dynamodb-lock-client/) pattern)
3. **A global atomic sequence counter** for event ordering
4. **A batch commit record** with fencing for crash-safe atomic visibility

This follows established distributed locking patterns rather than inventing custom lock management. The design is structurally equivalent to a **Write-Ahead Log with Two-Phase Commit**: the batch record is the WAL entry, event writes are the redo log, the commit is the commit record, and the cleanup process is crash recovery.

This gives us the DCB guarantee: the event store verifies that no new events matching the append condition's query have been added since the caller last read. If matching events are found, the append is rejected.

### Why DynamoDB-Native Locks (Not Redis)

We evaluated Redis (Elasticache) for lock management. While Redis offers faster lock operations (~1ms vs ~5ms), DynamoDB is the better choice for this use case:

- **Higher reliability**: DynamoDB has a 99.99% SLA with synchronous 3-AZ replication. Redis Elasticache has 99.9% with async replication and a ~30s failover window during which no locks can be acquired.
- **No split-brain risk**: DynamoDB conditional writes use single-leader-per-partition — no split-brain possible. Redis during failover can briefly accept writes on both old and new primary.
- **Single service dependency**: No additional infrastructure to provision, monitor, or failover.
- **Lock latency is not the bottleneck**: The 5ms DynamoDB lock operation is negligible compared to the BatchWriteItem event writes that follow. Faster locks don't improve end-to-end latency.

### Why Not Optimistic Watermarks?

We considered optimistic approaches using watermark items (tracking max sequence per event type or tag). These work but:

- **Type-level watermarks** cause false conflicts when two writers append the same event type for different entities (e.g. `CourseCreated` for course CS101 vs course CS102)
- **Fine-grained `(type, tagValue)` watermarks** require updating all relevant watermarks inside a `TransactWriteItems` call, which is limited to 100 items — problematic for large batch appends

The pessimistic lock approach avoids both issues: locks are fine-grained (no false conflicts between different entities), and the actual event writes use unlimited `BatchWriteItem` calls outside any transaction.

## Lock Manager

The lock manager implements the AWS DynamoDB Lock Client pattern directly, adapted to our batch lifecycle. It provides lease-based mutual exclusion with heartbeats and fencing.

### Lock Item Schema

```
_LOCK#<key> → {
  PK: "_LOCK#<key>",
  SK: "_LOCK#<key>",
  batchId: string,         // Which batch holds this lock
  leaseExpiry: number       // Epoch ms — when the lease expires if not renewed
}
```

### Lease-Based Acquisition

Locks are acquired with a **lease duration** (default 30 seconds). The lease expires automatically if not renewed — no separate cleanup process needed for lock expiry. A writer can only hold a lock while its lease is valid.

**Acquire (single lock):**

```
UpdateItem { PK: "_LOCK#StudentEnrolled:course=CS101" }
  SET batchId = :myBatchId, leaseExpiry = :expiry
  CONDITION: attribute_not_exists(batchId) OR leaseExpiry < :now
  ReturnValues: ALL_OLD
```

This single conditional write handles three cases atomically:
- **Lock doesn't exist** (`attribute_not_exists`): creates and acquires
- **Lock exists but lease expired** (`leaseExpiry < :now`): steals from crashed/slow writer
- **Lock exists with valid lease**: fails — another writer is active

`ReturnValues: ALL_OLD` returns the previous lock holder's `batchId` (if any), so we can mark their batch as FAILED (fencing — see below).

### All-or-Nothing Multi-Lock Acquisition

All lock keys are acquired in **parallel** — one network round trip regardless of lock count. If any lock fails to acquire, ALL acquired locks are released and the attempt is retried with exponential backoff + jitter.

```
1. Fire all UpdateItem calls in parallel
2. ALL succeed → proceed (collect any old batchIds from stolen locks)
3. ANY fail →
   a. Release locks we acquired: REMOVE batchId, leaseExpiry CONDITION batchId = :myBatchId
   b. Mark our batch FAILED immediately (not waiting for cleanup)
   c. Backoff with jitter, create a new batch, retry
```

This is the standard **all-or-nothing** lock acquisition pattern. Deadlocks are impossible because we never hold-and-wait — we either have all locks or none. The jittered backoff prevents livelock.

**Writer-side timeout**: After a configurable timeout (default 30 seconds), the writer gives up and throws `LockTimeoutError`. This prevents indefinite blocking if a scope is heavily contested.

### Heartbeat (Lease Renewal)

During long operations (writing 100K events can take seconds), the lock holder runs a background heartbeat that periodically extends the lease:

```
// Every 10 seconds (must be < lease duration):
UpdateItem { PK: "_LOCK#<key>" }
  SET leaseExpiry = :newExpiry
  CONDITION: batchId = :myBatchId
```

If the heartbeat's conditional write fails, the lock was stolen (lease expired between heartbeats). The writer detects this and aborts — it does NOT proceed to commit.

**Heartbeat timing**: The heartbeat interval (default 10 seconds) must be significantly less than the lease duration (default 30 seconds). This provides a safety margin: the writer has 2 missed heartbeats before the lease expires. A single missed heartbeat (network blip, GC pause) doesn't cause lock loss.

### Fencing: Preventing Stale Writers

The classic distributed lock fencing problem:

```
1. Writer A acquires lock, starts writing events
2. A pauses (GC, network partition) — lease expires
3. Writer B steals lock (lease expired), writes events, commits
4. A resumes, tries to commit — B's events are already committed
```

Without fencing, A's commit succeeds and both writers' events become visible — a consistency violation.

**Two fencing mechanisms work together:**

**Fencing mechanism 1 — Steal marks old batch FAILED:**

When a writer steals a lock (acquires an expired lease), it reads the old `batchId` from `ReturnValues: ALL_OLD` and marks that batch `FAILED`:

```
UpdateItem { PK: "_BATCH#<oldBatchId>" }
  SET status = "FAILED"
  CONDITION: status = "PENDING"
```

This prevents the old writer from committing even if it resumes.

**Fencing mechanism 2 — Commit requires PENDING status:**

The batch commit (Step 7) includes a condition:

```
UpdateItem { PK: "_BATCH#<uuid>" }
  SET status = "COMMITTED"
  CONDITION: status = "PENDING"
```

If the batch was already marked `FAILED` (by a lock stealer or cleanup), the commit fails. The writer detects this and aborts. Its partially-written events remain invisible (FAILED batch).

**Together**, these mechanisms guarantee that a stale writer can never commit after its locks have been stolen. The old batch is marked FAILED before the new writer proceeds, and the commit condition catches any race between the marking and the stale writer's commit attempt.

### Lock Release

After a successful commit, the writer explicitly releases its locks:

```
UpdateItem { PK: "_LOCK#<key>" }
  REMOVE batchId, leaseExpiry
  CONDITION: batchId = :myBatchId
```

Release is **best-effort** — if the release fails (network error, process crash), the lease simply expires and the next writer steals the lock. No harm done.

On **failed appends** (condition check failed, batch marked FAILED, any error): the writer marks its batch FAILED and releases locks. If it crashes before releasing, the leases expire naturally.

## Append Flow (Conditional — Lock Path)

All conditional appends use the lock path. `TransactWriteItems` cannot express "no events exist in partition X above position Y" (ConditionCheck operates on a single item by primary key, not partition queries), so the lock-based approach is used for all conditional appends regardless of batch size.

### Step 1: Create Batch Record

```
PutItem { PK: "_BATCH#<uuid>", status: "PENDING", createdAt: now }
```

The batch record gates event visibility — readers ignore events from PENDING batches. It also serves as the fencing target: the commit condition checks its status.

### Step 2: Compute Lock Keys

The lock key set is the **union** of keys derived from the append condition's query and the events being written. Both sources generate the same key type: `_LOCK#<eventType>:<tagValue>`.

For a query item `{ eventTypes: [CourseCreated, StudentEnrolled], tags: [course=CS101] }` and events of type `CourseCreated` with tags `[course=CS101, semester=fall]`:

```
Lock keys:
  _LOCK#CourseCreated:course=CS101       (from condition + event)
  _LOCK#CourseCreated:semester=fall      (from event)
  _LOCK#StudentEnrolled:course=CS101     (from condition)
```

Lock key derivation is the **cartesian product of types × tags** from both the condition query items and the events being written, deduplicated.

### Step 3: Acquire Locks (Parallel, All-or-Nothing)

Acquire all locks in parallel as described in the Lock Manager section. On failure, mark the batch FAILED immediately and retry with a new batch.

Start the heartbeat once all locks are acquired.

### Step 4: Read + Check Append Condition (Inside Lock)

Using **strongly consistent reads**, query events matching the append condition's query where `sequencePosition` exceeds the last position observed by the caller.

```
If any matching events found → stop heartbeat, release locks, mark batch FAILED, throw AppendConditionError
```

The locks guarantee no other writer is concurrently appending events that match the same query. The strongly consistent read guarantees we see all committed events.

**Why PENDING events don't cause false positives:** If an `I#` index item exists for a PENDING batch in our lock scope, that batch must have previously held our locks. Since we now hold the locks, that batch's lease expired and we stole the lock — meaning we marked it FAILED in Step 3. So any PENDING events in our scope are either from our own batch (not yet written) or from a FAILED batch (invisible to readers). The condition check only sees COMMITTED events.

### Step 5: Reserve Sequence Range

```
UpdateItem { PK: "_SEQ" }
  ADD value :batchSize
  ReturnValues: UPDATED_OLD
```

Atomic increment returns the previous value. Events are assigned positions `[oldValue + 1, oldValue + batchSize]`. This is an atomic `ADD`, not a conditional check — concurrent writers on different lock sets can reserve ranges simultaneously without conflicting.

Update the batch record with the reserved range:

```
UpdateItem { PK: "_BATCH#<uuid>" }
  SET seqStart = :start, seqEnd = :end
```

The global sequence counter is the **sole source of event ordering**. It guarantees a single total order across all events regardless of which client appended them. Gaps in the sequence (from failed batches) are expected and harmless — positions are never assumed to be contiguous. The implementation details of this counter (single item, sharded, etc.) may evolve, but the guarantee is the same: every committed event has a unique, globally comparable position.

### Step 6: Write Events (Parallel BatchWriteItem)

```
BatchWriteItem — 25 items per call, parallelised across connections
Each event written as multiple items (see Table Design for index items)
```

No transaction needed. No size limit. 100,000 events is just 4,000+ BatchWriteItem calls running in parallel. The locks prevent concurrent conflicting writes, and the PENDING batch status prevents partial visibility.

The heartbeat continues running during this step, keeping the lease alive for long writes.

### Step 7: Commit Batch (Fenced)

```
UpdateItem { PK: "_BATCH#<uuid>" }
  SET status = "COMMITTED"
  CONDITION: status = "PENDING"
```

The `CONDITION: status = "PENDING"` is the **fencing check**. If the batch was marked FAILED (by a lock stealer after our lease expired, or by our own abort logic), the commit fails. The writer throws an error — its events remain invisible.

On success, this single write atomically makes all events from this batch visible to readers.

### Step 8: Release Locks + Stop Heartbeat

Stop the heartbeat timer, then release all locks (best-effort, as described above).

On **any error** in Steps 3-7: stop heartbeat, release locks, mark batch FAILED.

## Append Flow (Unconditional)

Appends without a condition skip locking entirely:

```
1. Reserve sequence range (atomic ADD on _SEQ)
2. Write events via BatchWriteItem (no batchId — always visible)
```

No batch record, no locks, no heartbeat. Fully parallel with all other writers.

## Out-of-Order Commit Visibility — WIP

> **Status: Work in progress.** Implementation tracked in #44.

On the lock path, two concurrent writers on different scopes can reserve sequence ranges independently and commit in different order:

```
Client A: reserves positions 1-10
Client B: reserves positions 11-20
Client B: commits → events 11-20 visible
           ⏳ Client A still writing
Client A: commits → events 1-10 visible
```

Between B's commit and A's commit, events 1-10 are invisible. When A commits, they appear with lower positions — "back in time."

**Impact by consumer type:**

| Consumer | Impact | Why |
|----------|--------|-----|
| Append conditions | **Safe** | Condition check reads only COMMITTED events inside locks. PENDING events are invisible. Events appearing later with lower positions are below the observed position — they don't violate any condition. |
| Decision models | **Safe** | Same reasoning — the decision was made on the visible state, and the condition validates it. |
| Projections | **Can miss events** | A projection reading `Query.all()` sees events 11-20, checkpoints at position 20. Events 1-10 appear later but the projection starts from 21 next time — positions 1-10 are permanently skipped. |

**Proposed mitigation: `_COMMITTED_THROUGH` watermark.** The batch records already store `seqStart` and `seqEnd`. On commit, the adapter advances a monotonic watermark:

```
1. Commit batch (set status = COMMITTED, CONDITION: status = PENDING)
2. Query PENDING batches → find min(seqStart) across all PENDING
3. If no PENDING batches: advance _COMMITTED_THROUGH to _SEQ (current max)
4. If PENDING batches exist: advance _COMMITTED_THROUGH to min(seqStart) - 1
```

The watermark advance uses a conditional update to prevent lost updates from concurrent committers:

```
UpdateItem { PK: "_COMMITTED_THROUGH" }
  SET value = :newValue
  CONDITION: attribute_not_exists(value) OR value < :newValue
```

This ensures the watermark can only move forward — never backwards. Projections use `_COMMITTED_THROUGH` as their safe resume position.

## Read Flow

```typescript
read(query: Query, options?: ReadOptions): AsyncGenerator<EventEnvelope>
```

1. Query events matching type + tags using denormalized index items in the main table
2. For events **without** a `batchId`: yield immediately (came from a small transactional append — guaranteed complete)
3. For events **with** a `batchId`: check batch status
   - Committed batch IDs are cached in-memory (immutable once committed)
   - Unknown batch IDs: `BatchGetItem` on the `_BATCH#<id>` records
   - PENDING, FAILED, or missing → filter out those events
4. Yield matching, committed events ordered by `sequencePosition`

In practice, most reads from normal command handling encounter zero `batchId` events and need no extra lookups.

## Batch State Machine

```
PENDING  →  COMMITTED    (step 7 — happy path)
PENDING  →  FAILED       (cleanup process — crashed/stale batch detected)
```

Both `COMMITTED` and `FAILED` are terminal states. Lock acquisition treats both as "released" — the next writer can steal immediately.

## Cleanup Process

A periodic process (Lambda on a schedule, or application startup hook) handles crashed batches:

1. **Scan** for `PENDING` batches where `createdAt` is older than a threshold (e.g. 60 seconds)
2. **Transition** each to `FAILED`
3. **Optionally delete** orphaned event items written by the failed batch (identifiable by `batchId`)

This is the **only** place that reasons about batch age. The hot path (lock acquisition, reads, writes) never checks timestamps — it only checks the batch status field.

Benefits:
- **Observability**: FAILED batches can be monitored and alerted on — they represent crashes or bugs
- **Deterministic lock logic**: PENDING always means active, no guessing
- **Configurable recovery**: The cleanup threshold can be tuned independently of the append logic
- **Optional event cleanup**: Orphaned events from FAILED batches are invisible to readers (filtered out), so cleanup is a cost optimisation, not a correctness requirement

## Crash Safety Analysis

| Crash point | Batch status | Locks | Events | Recovery |
|-------------|-------------|-------|--------|----------|
| During lock acquisition | PENDING | Partial locks reference batch | None written | Cleanup marks batch FAILED → next writer steals |
| During condition check | PENDING | All locks reference batch | None written | Same — cleanup → FAILED → steal |
| During sequence reservation | PENDING | All locks held | None written | Cleanup → FAILED → steal. Sequence gap is harmless. |
| Mid-BatchWriteItem | PENDING | All locks held | Partial | **Partial events invisible** (PENDING/FAILED batch). Cleanup → FAILED → steal. |
| After all events, before commit | PENDING | All locks held | All written | Events invisible until cleanup → FAILED. Wasteful but safe. |
| After commit | COMMITTED | Locks reference committed batch | All visible | **Fully successful.** Next writer steals locks immediately. |

**Every crash scenario is safe.** Partial events from failed batches are invisible to readers because their batch status is never `COMMITTED`. The cleanup process transitions stale batches to `FAILED`, unblocking any writers waiting on those locks.

On the **happy path** (no crashes), there is never a wait for cleanup. Lock release is instantaneous via the batch commit.

## DynamoDB Table Design

### Single Table, No GSIs

All indexes are denormalized items in the main table. This is critical because **GSI reads are always eventually consistent** — they cannot be used for the strongly consistent condition check inside locks.

| Item type | PK | SK | Data |
|-----------|----|----|------|
| Event (primary) | `E#<seqPos>` | `E` | Full event: type, tags, data, metadata, timestamp, batchId? |
| Type+Tag index | `I#<eventType>#<tagValue>` | `<seqPos>` | Full event data |
| Type-only index | `IT#<eventType>` | `<seqPos>` | Full event data |
| Tag-only index | `IG#<tagValue>` | `<seqPos>` | Full event data |
| All-events bucket | `A#<bucket>` | `<seqPos>` | Full event data |
| Sequence counter | `_SEQ` | `_SEQ` | `value` (Number) |
| Batch record | `_BATCH#<uuid>` | `_BATCH#<uuid>` | `status`, `seqStart`, `seqEnd`, `createdAt` |
| Lock | `_LOCK#<key>` | `_LOCK#<key>` | `batchId`, `leaseExpiry` (epoch ms) |

Key design notes:

- `<seqPos>` is zero-padded (e.g. `00000000501`) for correct lexicographic sort order. 16 digits supports up to 9,999,999,999,999,999 events.
- `<bucket>` = `floor(seqPos / 10000)` — each bucket partition holds up to 10,000 events
- Full event data is stored on every index item — no secondary lookups on read (see rationale below)
- `IT#` and `IG#` indexes support type-only and tag-only **reads** only (not used for append condition checks or locks)
- `I#` is the critical index — used for both reads AND the strongly consistent condition check inside locks

### Index Roles

The three read indexes serve different purposes and have different consistency characteristics:

| Index | Used for | Consistency | Required by |
|-------|----------|-------------|-------------|
| `I#<type>#<tag>` | Condition checks + reads | **Strong** (inside locks) | Append conditions + reads |
| `IT#<type>` | Type-only reads | Eventual OK | Reads and projections only |
| `IG#<tag>` | Tag-only reads | Eventual OK | Reads and projections only |
| `A#<bucket>` | `Query.all()` catch-up | Eventual OK | Reads and projections only |

Because append conditions always specify both types and tags (adapter constraint), the condition check only ever queries `I#` items. The `IT#`, `IG#`, and `A#` indexes exist purely for read flexibility — projections, read models, and ad-hoc queries that don't need the full type+tag combination.

### Why Full Data on Every Index Item

The alternative is pointer-only indexes: store just the `seqPos` on index items, then `BatchGetItem` the primary `E#` items to get full event data. This halves write volume but doubles read latency:

| Approach | Write items per event (2 tags) | Read round trips | Read latency |
|----------|-------------------------------|-------------------|-------------|
| Full data on indexes | 7 | 1 query | 1-5ms |
| Pointer indexes + BatchGetItem | 7 (smaller items) | 1 query + 1 BatchGetItem | 5-15ms |

The full-data approach wins for reads because:

- **Decision model reads** (the hot path) complete in a single DynamoDB Query call — no secondary lookup
- **The condition check inside locks** is a single strongly consistent Query — adding a BatchGetItem step would increase lock hold time and contention window
- DynamoDB storage is cheap ($0.25/GB/month) — the duplication cost is negligible
- `BatchGetItem` is limited to 100 items per call, adding pagination complexity for larger reads

Trade-off: each event's data payload is stored `2 * tags + 3` times. For events with very large `data` fields (approaching DynamoDB's 400KB item limit), this amplifies storage cost. Events should keep their `data` payload lean — store references to large blobs (S3 keys, etc.) rather than embedding them.

### Write Amplification

For a `StudentEnrolled` event with tags `[course=CS101, student=STU42]`:

```
PK                                    | SK               | Purpose
E#501                                 | E                | Primary record (source of truth)
I#StudentEnrolled#course=CS101        | 00000000501      | Type+tag index (condition checks + reads)
I#StudentEnrolled#student=STU42       | 00000000501      | Type+tag index (condition checks + reads)
IT#StudentEnrolled                    | 00000000501      | Type-only read index
IG#course=CS101                       | 00000000501      | Tag-only read index
IG#student=STU42                      | 00000000501      | Tag-only read index
A#0                                   | 00000000501      | All-events bucket
```

**7 items per event** (with 2 tags). Formula: `1 + tags + 1 + tags + 1 = 2 * tags + 3`.

| Tags per event | Items written | BatchWriteItem calls per event |
|----------------|--------------|-------------------------------|
| 1 | 5 | 1 (fits in single call) |
| 2 | 7 | 1 |
| 3 | 9 | 1 |
| 5 | 13 | 1 |
| 10 | 23 | 1 |

For a batch of 1,000 events with 3 tags average: 9,000 items = 360 BatchWriteItem calls. Running in parallel at ~5ms each from a single Fargate task, this completes in well under a second.

All index items for a single event should be written in the **same BatchWriteItem call** where possible (up to 25 items per call). This ensures index items appear together — a reader won't see an `I#` item without the corresponding `IT#` and `IG#` items for the same event.

### Event Item Schema

Every index item stores the same event attributes. The shared schema:

```typescript
{
  PK: string,                // Partition key (varies by item type)
  SK: string,                // Sort key (seqPos, zero-padded)
  type: string,              // Event type (e.g. "StudentEnrolled")
  tags: string[],            // All tags as StringSet (e.g. ["course=CS101", "student=STU42"])
  data: Record<string, any>, // Event payload (Map)
  metadata: Record<string, any>, // Event metadata (Map)
  timestamp: string,         // ISO 8601 UTC
  seqPos: number,            // Numeric sequence position (for arithmetic, not just sort order)
  batchId?: string           // Present only for events from large batch appends
}
```

The `seqPos` attribute is stored as a Number in addition to being encoded in the SK. The SK is for sort order; the numeric attribute is for returning in the `EventEnvelope` and for arithmetic comparisons in application code.

### Query Routing

| Query shape | DynamoDB Query | Notes |
|-------------|---------------|-------|
| Types + tags | `PK = "I#<type>#<firstTag>", SK >= fromSeqPos` | Pick one tag for PK, filter remaining tags client-side |
| Types only | `PK = "IT#<type>", SK >= fromSeqPos` | One query per type, merge results |
| Tags only | `PK = "IG#<tag>", SK >= fromSeqPos` | One query per tag, filter by type client-side if needed |
| `Query.all()` | `PK = "A#<bucket>", SK >= fromSeqPos` | Sequential bucket reads |
| Backwards | `ScanIndexForward: false`, `SK <= fromSeqPos` | Native DynamoDB reverse scan |
| Limit | Paginate results, apply limit after client-side filtering | See below |
| Multiple QueryItems | Execute each as above, merge + deduplicate by seqPos | OR semantics |

### Multi-Tag Query Mechanics

When a QueryItem has multiple tags (e.g. `tags: [course=CS101, semester=fall]`), the adapter picks **one tag** for the partition key and filters the rest client-side:

```
QueryItem: { eventTypes: ["StudentEnrolled"], tags: [course=CS101, semester=fall] }

→ DynamoDB Query: PK = "I#StudentEnrolled#course=CS101", SK >= 0
→ Client-side filter: event.tags contains "semester=fall"
→ Result: events matching ALL criteria
```

**Which tag to pick?** In DCB patterns, tags are typically entity identifiers (`course=CS101`, `student=STU42`) which are highly selective — usually a handful of events per entity. The adapter should pick the **first tag** in the QueryItem's tag list. Callers can optimise by ordering their most selective tag first, but in practice any entity-level tag will be selective enough that the client-side filter discards very little.

For a QueryItem with **multiple event types** and a tag, the adapter runs one query per type and merges:

```
QueryItem: { eventTypes: ["CourseCreated", "StudentEnrolled"], tags: [course=CS101] }

→ Query 1: PK = "I#CourseCreated#course=CS101"
→ Query 2: PK = "I#StudentEnrolled#course=CS101"
→ Merge by seqPos, deduplicate, sort
```

These queries run in parallel — one round trip total.

### Multiple QueryItems (OR Logic)

Multiple QueryItems in a single Query are combined with OR semantics, matching the Postgres implementation's `UNION ALL` + `GROUP BY`:

```typescript
Query.fromItems([
  { eventTypes: ["CourseCreated"], tags: Tags.from(["course=CS101"]) },
  { eventTypes: ["StudentEnrolled"], tags: Tags.from(["student=STU42"]) }
])
```

Each QueryItem is executed independently (potentially in parallel), results are merged into a single stream ordered by `seqPos`, and duplicates (same event matching multiple QueryItems) are removed.

Deduplication uses the `seqPos` as the identity — if two QueryItems both match event at position 501, it appears once in the output.

### All-Events Bucketing (Query.all)

The `A#<bucket>` partition scheme divides the event sequence into fixed-size buckets:

```
Bucket 0: A#0  → events at positions 1–10,000
Bucket 1: A#1  → events at positions 10,001–20,000
Bucket 2: A#2  → events at positions 20,001–30,000
...
```

`Query.all()` reads proceed bucket by bucket. For `fromSequencePosition: 45000`:

1. Start at bucket `floor(45000 / 10000) = 4`
2. Query `PK = "A#4", SK >= "00000000045000"`
3. When exhausted, move to `PK = "A#5"`, then `A#6`, etc.
4. Stop when a bucket returns no results (or limit reached)

**Bucket size trade-off**: 10,000 events per bucket means each partition holds ~10MB at 1KB/event, well within DynamoDB's 10GB partition limit. Smaller buckets (1,000) would mean more partition hops for large catch-ups. Larger buckets (100,000) could approach partition throughput limits under heavy read load. 10,000 is a reasonable default.

For **backwards reads** with `Query.all()`, walk buckets in reverse: start at the highest known bucket, use `ScanIndexForward: false`.

### Pagination and DynamoDB Limits

DynamoDB returns at most **1MB of data per Query call**. At ~1KB per event, that's ~1,000 events per page. The adapter must handle pagination:

```
1. Execute Query with optional Limit
2. If LastEvaluatedKey present in response → more pages available
3. Continue querying with ExclusiveStartKey = LastEvaluatedKey
4. Yield events as they arrive (AsyncGenerator — no need to buffer all pages)
```

**Important**: DynamoDB's `Limit` parameter controls how many items are **evaluated**, not how many pass the filter. When client-side tag filtering is active, the adapter must keep paginating until it has enough filtered results or the partition is exhausted. The caller's `limit` option (from `ReadOptions`) is applied by the adapter after filtering, not passed directly to DynamoDB.

### Condition Check Query (Inside Locks)

The append condition check uses the `I#` (type+tag) index items with **strongly consistent reads**:

```
Query:
  PK = "I#StudentEnrolled#course=CS101"
  SK > "00000000500"    (last observed position)
  ConsistentRead: true
  Limit: 1              (only need to know if ANY exist)
```

Single query, returns 0 or 1 item. If 1 → matching events found, append is rejected.

For a condition with multiple QueryItems, each is checked independently. If **any** QueryItem finds a matching event above the last observed position, the entire append is rejected. These checks can run in parallel.

For a QueryItem with multiple tags (e.g. `tags: [course=CS101, semester=fall]`), the same tag-picking strategy applies: query one tag's `I#` partition, filter the rest. The check remains conservative — if the `I#` partition has events above the last observed position that don't match the additional tags, the check still passes (no false rejections from the filter).

### Strongly Consistent vs Eventually Consistent Reads

| Operation | Consistency | Why |
|-----------|-------------|-----|
| Condition check (inside lock) | **Strong** | Must see all committed events to enforce the DCB guarantee. A stale read could miss a concurrent write and allow a conflicting append. |
| Decision model read (before append) | **Eventual OK** | The append condition catches any events missed by a stale read. An eventually consistent read just means a slightly older position, not a correctness issue. |
| Projection / read model catch-up | **Eventual OK** | Projections are inherently asynchronous. Eventually consistent reads cost half the RCU. |
| Batch status check | **Strong** | Must see the current batch status to correctly filter events. A stale read could show a PENDING batch as COMMITTED (unlikely but possible if the batch just committed). |

Strongly consistent reads cost 2x the RCU of eventually consistent reads. Since only the condition check and batch status check require strong consistency, most read volume (projections, read models) uses the cheaper eventually consistent path.

## Performance Expectations

All estimates assume same-region Fargate + DynamoDB on-demand.

| Operation | Latency | Throughput |
|-----------|---------|------------|
| Small append (1-5 events, unconditional) | 5-10ms | Thousands/sec (parallel, no contention) |
| Small append (1-5 events, conditional) | 15-25ms | Hundreds/sec per lock set (lock acquire + check + write + commit) |
| Large append (1,000 events, conditional) | 100-500ms | Hundreds/sec per lock set, unlimited across different entities |
| Very large append (100K events) | 5-15s | Bounded by BatchWriteItem parallelism |
| Sequence counter (atomic ADD) | ~5ms | ~1,000 increments/sec = up to 200K events/sec with batching |
| Read (type + tag query, single entity) | 1-5ms | Thousands/sec, scales with DynamoDB partitions |
| Read (type-only query, large result set) | 5-50ms | Bounded by 1MB pages, parallelised across types |
| Read (Query.all, projection catch-up) | ~2ms per bucket page | Sequential bucket reads, ~10K events per page |
| Lock acquisition (parallel, no contention) | 5-10ms total | Effectively unlimited for non-conflicting keys |
| Lock steal (expired lease) | 5-10ms (single conditional write) | N/A |

DynamoDB on-demand scales automatically. The primary throughput constraint is the application's ability to parallelise calls, not DynamoDB itself. 10,000+ events/sec read and write is comfortably achievable from a single Fargate task.

### Partition Hot Key Analysis

| Item type | Partition key | Writes/sec concern | Mitigation |
|-----------|--------------|-------------------|------------|
| `_SEQ` | Single item | ~1,000 atomic ADDs/sec | Sufficient for most workloads. Each ADD reserves a range, so actual event throughput is much higher. |
| `I#<type>#<tag>` | Per entity per type | Very low (single entity writes are rare concurrently) | Natural distribution across entities |
| `IT#<type>` | Per event type | Could be hot for high-volume types | DynamoDB adaptive capacity handles this; partition splits automatically |
| `A#<bucket>` | Per 10K events | Only the current bucket receives writes | Naturally rotates to new partitions as events grow |

The most likely hot key is `_SEQ`. If this becomes a bottleneck at extreme scale (>1,000 appends/sec), it could be sharded into multiple counters with range pre-allocation — but this adds complexity and should only be considered when measured as a real bottleneck.

## Open Questions

- **Out-of-order batch commits (WIP)**: On the lock path, concurrent writers can commit in different order than they reserved sequence ranges, causing events to appear "back in time." Safe for append conditions and decision models, but projections can miss events. Proposed fix: `_COMMITTED_THROUGH` monotonic watermark derived from batch records. See [Out-of-Order Commit Visibility](#out-of-order-commit-visibility--wip) section. To be implemented in #44.
- **Lock lease tuning**: Default lease duration (30s) and heartbeat interval (10s) may need adjustment based on observed write latencies. Too short → healthy writers lose leases during large writes. Too long → crashed writers block their scopes for longer. These are configuration options, not code changes.
- **Orphaned event deletion**: Events from FAILED batches are invisible to readers but still consume storage. A periodic process can delete them (identifiable by `batchId`). Not urgent — they're inert. DynamoDB TTL on FAILED batch records (e.g. 24h) can trigger cascading cleanup.
- **Tag selectivity heuristics**: When a QueryItem has multiple tags, the adapter picks one for the partition key lookup. Currently proposed: use the first tag. Could evolve to maintain tag cardinality statistics for smarter selection — but this is an optimisation, not a correctness concern.
- **Events with many tags**: Write amplification scales as `2 * tags + 3` items per event. Events with 10+ tags produce 23+ items. Acceptable for DynamoDB throughput but worth monitoring for cost. Consider whether domain modelling can reduce tag count (e.g. a composite tag `course-semester=CS101-fall` instead of two separate tags, where the combined value is the natural consistency boundary).
- **Large event payloads**: Full data duplication means each event's `data` field is stored `2 * tags + 3` times. For events with payloads exceeding ~50KB, consider storing the payload in S3 and referencing it by key in the event data. The 400KB DynamoDB item size limit is a hard ceiling.
- **Sequence counter sharding**: The single `_SEQ` item supports ~1,000 increments/sec. If append throughput exceeds this (rare), the counter can be sharded into multiple counter items with range pre-allocation. Defer until measured as a bottleneck.
