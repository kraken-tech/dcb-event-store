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
// Does not affect AssetCreated, CourseUpdated, or any other event type.
```

**Reads are unrestricted.** `Query.all()`, type-only queries, and tag-only queries all work for reads and projections. The constraints only apply to append conditions.

```typescript
// All valid reads:
eventStore.read(Query.all())                                             // full catch-up
eventStore.read(Query.all(), { fromSequencePosition: pos })              // resume projection
eventStore.read(Query.fromItems([{ eventTypes: ["CourseCreated"] }]))     // type-only read
eventStore.read(Query.fromItems([{ tags: Tags.from(["asset=123"]) }]))   // tag-only read

// Appending without a condition — no constraints, no locks:
eventStore.append(events)
```

## Architecture Overview

### Consistency Strategy: Batch-Linked Pessimistic Locks

DynamoDB lacks Postgres's `SERIALIZABLE` isolation and SQL subqueries. Instead, we use:

1. **Fine-grained pessimistic locks** on `(eventType, tagValue)` pairs for mutual exclusion
2. **A global atomic sequence counter** for event ordering
3. **A batch commit record** for crash-safe atomic visibility

Lock items reference the batch that holds them. When a batch commits, all its locks are **implicitly released** — the next writer checks the batch status and steals the lock immediately. No explicit release step. No TTL wait on the happy path.

This gives us the DCB guarantee: the event store verifies that no new events matching the append condition's query have been added since the caller last read. If matching events are found, the append is rejected.

### Why Not Optimistic Watermarks?

We considered optimistic approaches using watermark items (tracking max sequence per event type or tag). These work but:

- **Type-level watermarks** cause false conflicts when two writers append the same event type for different entities (e.g. `AssetCreated` for asset 123 vs asset 456)
- **Fine-grained `(type, tagValue)` watermarks** require updating all relevant watermarks inside a `TransactWriteItems` call, which is limited to 100 items — problematic for large batch appends

The pessimistic lock approach avoids both issues: locks are fine-grained (no false conflicts between different entities), and the actual event writes use unlimited `BatchWriteItem` calls outside any transaction.

## Append Flow

### Step 1: Create Batch Record

```
PutItem { PK: "_BATCH#<uuid>", status: "PENDING", createdAt: now }
```

The batch record is the **source of truth** for whether a set of locks is still active. It also gates event visibility — readers ignore events from PENDING batches.

### Step 2: Compute Lock Keys

The lock key set is the **union** of keys derived from the append condition's query and the events being written. Both sources generate the same key type: `_LOCK#<eventType>:<tagValue>`.

For a query item `{ eventTypes: [A, B], tags: [x=1] }` and events of type A with tags `[x=1, y=2]`:

```
Lock keys (sorted, to prevent deadlocks):
  _LOCK#A:x=1     (from condition: type A × tag x=1)
  _LOCK#A:y=2     (from event: type A × tag y=2)
  _LOCK#B:x=1     (from condition: type B × tag x=1)
```

Lock key derivation is the **cartesian product of types × tags** from both the condition query items and the events being written, deduplicated and sorted.

### Step 3: Acquire Locks (Parallel)

All lock acquisitions fire as **parallel `UpdateItem` calls**. Each lock item stores only the `batchId` of the batch that holds it.

**Fast path — lock not held (or lock item doesn't exist yet):**

```
UpdateItem { PK: "_LOCK#AssetCreated:asset=123" }
  SET batchId = :myBatchId
  CONDITION: attribute_not_exists(batchId)
```

**Contention path — lock held by another batch:**

```
1. GetItem _LOCK#<key>              → currentBatchId
2. GetItem _BATCH#<currentBatchId>  → check status

   If COMMITTED or FAILED (or batch record missing):
     → Previous writer finished or was cleaned up. Steal immediately:
       UpdateItem SET batchId = :myBatchId
         CONDITION: batchId = :oldBatchId

   If PENDING:
     → Active writer. Backoff with jitter, retry.
```

The lock acquisition logic never reasons about timeouts or batch age. A `PENDING` batch is **always** treated as active. Only the cleanup process (see below) decides when a batch is dead and transitions it to `FAILED`.

The `CONDITION: batchId = :oldBatchId` on the steal prevents two writers from stealing the same lock simultaneously — only one wins the conditional write.

- If **all locks acquired**: proceed to step 4
- If **any lock contested**: release acquired locks (set batchId to a sentinel or delete), backoff, retry from step 3
- Locks are always acquired in **sorted key order** to prevent deadlocks

### Step 4: Read + Check Append Condition (Inside Lock)

Using **strongly consistent reads**, query events matching the append condition's query where `sequencePosition` exceeds the last position observed by the caller.

```
If any matching events found → release locks, throw AppendConditionError
```

The locks guarantee no other writer is concurrently appending events that match the same query. The strongly consistent read guarantees we see all committed events.

### Step 5: Reserve Sequence Range

```
UpdateItem { PK: "_SEQ" }
  ADD value :batchSize
  ReturnValues: UPDATED_OLD
```

Atomic increment returns the previous value. Events are assigned positions `[oldValue + 1, oldValue + batchSize]`. This is an atomic `ADD`, not a conditional check — concurrent writers on different lock sets can reserve ranges simultaneously without conflicting.

The global sequence counter is the **sole source of event ordering**. It guarantees a single total order across all events regardless of which client appended them. Gaps in the sequence (from failed batches) are expected and harmless — positions are never assumed to be contiguous. The implementation details of this counter (single item, sharded, etc.) may evolve, but the guarantee is the same: every committed event has a unique, globally comparable position.

### Step 6: Write Events (Parallel BatchWriteItem)

```
BatchWriteItem — 25 items per call, parallelised across connections
Each event written as multiple items (see Table Design for index items)
```

No transaction needed. No size limit. 100,000 events is just 4,000+ BatchWriteItem calls running in parallel. The locks prevent concurrent conflicting writes, and the PENDING batch status prevents partial visibility.

### Step 7: Commit Batch

```
UpdateItem { PK: "_BATCH#<uuid>" }
  SET status = "COMMITTED"
```

This single write atomically:
- Makes all events from this batch visible to readers
- Implicitly releases every lock held by this batch (next writer will see COMMITTED and steal)

**No explicit lock release step.** When the next writer encounters a lock pointing to this batch, it reads the batch record, sees `COMMITTED`, and immediately steals the lock.

### Optimisation: Small Appends (Transactional Path)

For appends where the total item count fits within `TransactWriteItems`' 100-item limit (~40 events depending on tag count), use a **single transaction** instead:

```
TransactWriteItems:
  ConditionCheck on relevant lock keys (no matching events with position above the caller's last observed)
  Put each event (with all index items)
  Update _SEQ
```

No locks, no batch record, no `batchId` on events. Fully atomic. This covers the common case (command handlers producing 1-5 events) with zero overhead on reads.

The adapter selects the appropriate path automatically based on payload size. The caller always just calls `append(events, condition)`.

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

All indexes are denormalized items in the main table. This is critical because **GSI reads are always eventually consistent** they cannot be used for the strongly consistent condition check inside locks.

| Item type | PK | SK | Data |
|-----------|----|----|------|
| Event (primary) | `E#<seqPos>` | `E` | Full event: type, tags, data, metadata, timestamp, batchId? |
| Type+Tag index | `I#<eventType>#<tagValue>` | `<seqPos>` | Full event data |
| Type-only index | `IT#<eventType>` | `<seqPos>` | Full event data |
| Tag-only index | `IG#<tagValue>` | `<seqPos>` | Full event data |
| All-events bucket | `A#<bucket>` | `<seqPos>` | Full event data |
| Sequence counter | `_SEQ` | `_SEQ` | `value` (Number) |
| Batch record | `_BATCH#<uuid>` | `_BATCH#<uuid>` | `status`, `seqStart`, `seqEnd`, `createdAt` |
| Lock | `_LOCK#<key>` | `_LOCK#<key>` | `batchId` |

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

For an event of type `AssetCreated` with tags `[asset=123, location=NYC]`:

```
PK                             | SK               | Purpose
E#501                          | E                | Primary record (source of truth)
I#AssetCreated#asset=123       | 00000000501      | Type+tag index (condition checks + reads)
I#AssetCreated#location=NYC    | 00000000501      | Type+tag index (condition checks + reads)
IT#AssetCreated                | 00000000501      | Type-only read index
IG#asset=123                   | 00000000501      | Tag-only read index
IG#location=NYC                | 00000000501      | Tag-only read index
A#0                            | 00000000501      | All-events bucket
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
  type: string,              // Event type (e.g. "AssetCreated")
  tags: string[],            // All tags as StringSet (e.g. ["asset=123", "location=NYC"])
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

When a QueryItem has multiple tags (e.g. `tags: [asset=123, location=NYC]`), the adapter picks **one tag** for the partition key and filters the rest client-side:

```
QueryItem: { eventTypes: ["AssetCreated"], tags: [asset=123, location=NYC] }

→ DynamoDB Query: PK = "I#AssetCreated#asset=123", SK >= 0
→ Client-side filter: event.tags contains "location=NYC"
→ Result: events matching ALL criteria
```

**Which tag to pick?** In DCB patterns, tags are typically entity identifiers (`asset=123`, `course=CS101`) which are highly selective — usually a handful of events per entity. The adapter should pick the **first tag** in the QueryItem's tag list. Callers can optimise by ordering their most selective tag first, but in practice any entity-level tag will be selective enough that the client-side filter discards very little.

For a QueryItem with **multiple event types** and a tag, the adapter runs one query per type and merges:

```
QueryItem: { eventTypes: ["AssetCreated", "AssetUpdated"], tags: [asset=123] }

→ Query 1: PK = "I#AssetCreated#asset=123"
→ Query 2: PK = "I#AssetUpdated#asset=123"
→ Merge by seqPos, deduplicate, sort
```

These queries run in parallel — one round trip total.

### Multiple QueryItems (OR Logic)

Multiple QueryItems in a single Query are combined with OR semantics, matching the Postgres implementation's `UNION ALL` + `GROUP BY`:

```typescript
Query.fromItems([
  { eventTypes: ["AssetCreated"], tags: Tags.from(["asset=123"]) },
  { eventTypes: ["LocationChanged"], tags: Tags.from(["location=NYC"]) }
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
  PK = "I#AssetCreated#asset=123"
  SK > "00000000500"    (last observed position)
  ConsistentRead: true
  Limit: 1              (only need to know if ANY exist)
```

Single query, returns 0 or 1 item. If 1 → matching events found, append is rejected.

For a condition with multiple QueryItems, each is checked independently. If **any** QueryItem finds a matching event above the ceiling, the entire append is rejected. These checks can run in parallel.

For a QueryItem with multiple tags (e.g. `tags: [asset=123, location=NYC]`), the same tag-picking strategy applies: query one tag's `I#` partition, filter the rest. The check remains conservative — if the `I#` partition has events above the ceiling that don't match the additional tags, the check still passes (no false rejections from the filter).

### Strongly Consistent vs Eventually Consistent Reads

| Operation | Consistency | Why |
|-----------|-------------|-----|
| Condition check (inside lock) | **Strong** | Must see all committed events to enforce the DCB guarantee. A stale read could miss a concurrent write and allow a conflicting append. |
| Decision model read (before append) | **Eventual OK** | The append condition catches any events missed by a stale read. An eventually consistent read just means a slightly older ceiling, not a correctness issue. |
| Projection / read model catch-up | **Eventual OK** | Projections are inherently asynchronous. Eventually consistent reads cost half the RCU. |
| Batch status check | **Strong** | Must see the current batch status to correctly filter events. A stale read could show a PENDING batch as COMMITTED (unlikely but possible if the batch just committed). |

Strongly consistent reads cost 2x the RCU of eventually consistent reads. Since only the condition check and batch status check require strong consistency, most read volume (projections, read models) uses the cheaper eventually consistent path.

## Performance Expectations

All estimates assume same-region Fargate + DynamoDB on-demand.

| Operation | Latency | Throughput |
|-----------|---------|------------|
| Small append (1-5 events, transactional) | 5-15ms | Thousands/sec |
| Large append (1,000 events, lock-based) | 100-500ms | Hundreds/sec per lock set, unlimited across different entities |
| Very large append (100K events) | 5-15s | Bounded by BatchWriteItem parallelism |
| Sequence counter (atomic ADD) | ~5ms | ~1,000 increments/sec = up to 200K events/sec with batching |
| Read (type + tag query, single entity) | 1-5ms | Thousands/sec, scales with DynamoDB partitions |
| Read (type-only query, large result set) | 5-50ms | Bounded by 1MB pages, parallelised across types |
| Read (Query.all, projection catch-up) | ~2ms per bucket page | Sequential bucket reads, ~10K events per page |
| Lock acquisition (parallel, no contention) | 5-10ms total | Effectively unlimited for non-conflicting keys |
| Lock steal (happy path, batch committed) | 10-15ms (2 reads + 1 write) | N/A |

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

- **Cleanup threshold**: How long a PENDING batch must exist before the cleanup process marks it FAILED. Likely 30-60 seconds. This only affects crash recovery — the hot path never checks batch age.
- **Cleanup implementation**: Options include a CloudWatch-scheduled Lambda, an application startup hook, or a DynamoDB Streams trigger. Could also run lazily — when a writer encounters a PENDING lock, it notifies the cleanup process.
- **Orphaned event deletion**: Events from FAILED batches are invisible to readers but still consume storage. Cleanup can optionally delete them (identifiable by `batchId`). Not urgent — they're inert.
- **Tag selectivity heuristics**: When a QueryItem has multiple tags, the adapter picks one for the partition key lookup. Currently proposed: use the first tag. Could evolve to maintain tag cardinality statistics for smarter selection — but this is an optimisation, not a correctness concern.
- **Events with many tags**: Write amplification scales as `2 * tags + 3` items per event. Events with 10+ tags produce 23+ items. Acceptable for DynamoDB throughput but worth monitoring for cost. Consider whether domain modelling can reduce tag count (e.g. a composite tag `asset-location=123-NYC` instead of two separate tags, where the combined value is the natural consistency boundary).
- **Large event payloads**: Full data duplication means each event's `data` field is stored `2 * tags + 3` times. For events with payloads exceeding ~50KB, consider storing the payload in S3 and referencing it by key in the event data. The 400KB DynamoDB item size limit is a hard ceiling.
- **Sequence counter sharding**: The single `_SEQ` item supports ~1,000 increments/sec. If append throughput exceeds this (rare), the counter can be sharded: multiple counter items each managing a disjoint range, with writers randomly picking a shard. This breaks the total ordering guarantee within concurrent appends but maintains ordering within each append — acceptable if downstream consumers handle out-of-order delivery. Defer until measured as a bottleneck.
