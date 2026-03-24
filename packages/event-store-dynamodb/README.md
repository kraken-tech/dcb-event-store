# @dcb-es/event-store-dynamodb

DynamoDB implementation of the `EventStore` interface from `@dcb-es/event-store`. Full [DCB compliance](https://dcb.events), crash-safe, no artificial batch size limits.

The design follows standard database transaction patterns mapped onto DynamoDB: a **write-ahead log** (transaction record gates visibility), **two-phase commit** (fenced commit), **lease-based pessimistic locking**, and **fencing tokens** to prevent stale writers.

## Adapter Constraints

Two constraints beyond the base `EventStore` interface, enabling fine-grained `(eventType, tagValue)` pair locks:

1. **Every event must have at least one tag.**
2. **Every `QueryItem` in an `AppendCondition` must have non-empty `types` AND non-empty `tags`.**

Two writers only conflict if they share an exact `(type, tag)` pair. Appending `CourseCreated` for CS101 never conflicts with `CourseCreated` for CS102.

If you need a type-level constraint (e.g. a global course counter), model it with an explicit tag:

```typescript
{ type: "CourseCreated", tags: Tags.from(["course=CS101", "courseIndex=global"]) }
// Lock: _LOCK#CourseCreated:courseIndex=global — serializes course creation only
```

**Reads are unrestricted.** `Query.all()`, type-only, and tag-only queries all work. Constraints apply only to append conditions.

## Table Design

Single table, no GSIs. All indexes are denormalized pointer items — GSI reads are eventually consistent and cannot be used for strongly consistent condition checks.

DynamoDB tables have a **partition key** (PK) and an optional **sort key** (SK). Together they form the primary key. All items with the same PK live in one partition, ordered by SK. A Query fetches items from a single partition, optionally filtering by SK range — this is the only efficient read pattern. There are no joins, no secondary indexes on arbitrary columns. Everything in the "Data" column below is stored as attributes on the item.

| Item type | PK | SK | Data |
|-----------|----|----|------|
| Event | `E#<seqPos>` | `E` | Full event data, `txnId?` |
| Type+Tag pointer | `I#<type>#<tag>` | `<seqPos>` | `seqPos` only |
| Type-only pointer | `IT#<type>` | `<seqPos>` | `seqPos` only |
| Tag-only pointer | `IG#<tag>` | `<seqPos>` | `seqPos` only |
| All-events pointer | `A#<bucket>` | `<seqPos>` | `seqPos` only |
| Sequence counter | `_SEQ` | `_SEQ` | `value` |
| Transaction record | `_TXN` | `<uuid>` | `status`, `createdAt`, `leaseDuration`, `fencingToken` |
| Lock | `_LOCK#<key>` | `_LOCK#<key>` | `txnId` |

- `<seqPos>` is zero-padded to 16 digits for lexicographic sort
- `<bucket>` = `floor(seqPos / 10000)` — 10,000 events per partition
- Event data stored **once** in `E#` — all other items are lightweight pointers (~50 bytes)
- `I#` is the critical index — used for both reads AND strongly consistent condition checks inside locks
- `IT#` and `IG#` are read-only conveniences, never used in condition checks or locks

### Write Amplification

Per event: `2 * tags + 3` items. For a `StudentEnrolled` with tags `[course=CS101, student=STU42]`:

```
E#501                           E       full event data (~1KB)
I#StudentEnrolled#course=CS101  501     type+tag pointer (~50B)
I#StudentEnrolled#student=STU42 501     type+tag pointer
IT#StudentEnrolled              501     type-only pointer
IG#course=CS101                 501     tag-only pointer
IG#student=STU42                501     tag-only pointer
A#0                             501     all-events pointer
```

7 items. 1,000 events × 3 tags average = 9,000 items = 360 BatchWriteItem calls, completing in under a second in parallel.

## Transaction Record

The transaction record is the central coordination point. It gates event visibility, carries the lease for all locks held by the transaction, and serves as the fencing target.

```
PK: _TXN, SK: <uuid> → {
  status:        ACTIVE | COMMITTED | ABORTED
  leaseDuration: ms (e.g. 30000)
  fencingToken:  monotonic integer, incremented by each heartbeat
  createdAt:     epoch ms
}
```

All transaction records share the partition key `_TXN`, enabling recovery to find ACTIVE transactions with a single Query rather than a full table Scan.

No absolute timestamps are stored — only the relative `leaseDuration`. This avoids clock skew issues entirely: liveness decisions are made by measuring elapsed time on the observer's own clock (see Lock Acquisition below).

State machine: `ACTIVE → COMMITTED` (happy path) or `ACTIVE → ABORTED` (crash/steal/abort). Both terminal.

The **heartbeat** is a single write to the transaction record, regardless of how many locks are held:

```
UpdateItem PK=_TXN, SK=<uuid>
  SET fencingToken = fencingToken + 1
  CONDITION: status = ACTIVE
```

Default heartbeat interval: 10s. Default lease duration: 30s (three heartbeat intervals).

If the heartbeat's condition fails (transaction was aborted by a stealer), the writer aborts immediately.

## Lock Manager

Lock items contain only a `txnId` — a pointer to the transaction record that holds them:

```
_LOCK#<type>:<tag> → { txnId }
```

### Acquisition

Lock keys are acquired **sequentially in sorted lexicographic order**. This prevents livelock: two writers contending on overlapping sets always attempt in the same order, so one always wins the first contested lock and the other backs off.

There is a single retry loop per lock key. On each attempt:

1. Try to acquire: `UpdateItem _LOCK#<key> SET txnId = :mine CONDITION attribute_not_exists(txnId)`
2. If it succeeds → lock acquired, move to next key
3. If held → fetch the transaction record (`PK=_TXN, SK=<txnId>`) to check liveness (reuse if already fetched — all locks from the same transaction share one record). Note the `fencingToken` and `leaseDuration`, and start tracking elapsed time locally since the first observation of this transaction.
4. If you have been observing the **same fencing token on the same transaction** for longer than its `leaseDuration` → holder is dead:
   - Abort old transaction: `UpdateItem PK=_TXN, SK=<old> SET status = ABORTED CONDITION fencingToken = :observed`
   - If that succeeds: overwrite lock: `UpdateItem _LOCK#<key> SET txnId = :mine CONDITION txnId = :old`
   - If fencing token changed (holder heartbeated between your observations): reset your timer — holder is alive
5. Otherwise → back off (1–2s + jitter), retry from step 1

The steal condition emerges naturally from repeated retries: each attempt re-reads the transaction record, and if the fencing token hasn't changed after enough retries spanning the full lease duration, the holder is definitively stalled. No absolute timestamps are compared across machines — the observer only measures elapsed time on its own clock.

If a lock is released between retries (holder committed or aborted), step 1 succeeds immediately on the next attempt.

If any lock in the sorted sequence fails to acquire within a configurable timeout (default 30s), all acquired locks are released, the transaction is aborted, and the writer retries with a new transaction. After a global timeout, throw `LockTimeoutError`.

### Fencing

Two mechanisms prevent a stale writer (whose lease expired) from committing:

1. **Steal aborts old transaction.** When a lock is stolen, the old transaction's status is set to ABORTED before the new writer proceeds.
2. **Commit requires ACTIVE.** The commit is conditional on `status = ACTIVE`. If the transaction was already aborted, the commit fails and the writer aborts.

Together: a stale writer can never commit after its locks have been stolen.

### Release

After commit, release locks best-effort:

```
UpdateItem _LOCK#<key>
  REMOVE txnId
  CONDITION: txnId = :myTxnId
```

If release fails (crash, network error), the lease expires naturally and the next writer steals.

## Append Flow (Conditional)

A conditional append is a transaction that can contain one or more sub-batches, each with its own events and append condition. All sub-batches commit atomically — either all become visible or none do.

The common case is a single sub-batch (one `append()` call). For large imports or streaming writes, multiple sub-batches can be staged within the same transaction before committing.

### Step 1: Begin Transaction

```
PutItem PK=_TXN, SK=<uuid> { status: ACTIVE, createdAt: now, leaseDuration: 30000, fencingToken: 0 }
```

Start the heartbeat.

### Steps 2–6: Stage Sub-Batch (repeat per batch)

Each sub-batch stages its events within the open transaction:

**2. Compute lock keys** — cartesian product of `types × tags` from this batch's condition query items, unioned with `eventType × tags` from this batch's events. Deduplicated, sorted lexicographically. Merge with the already-held lock set.

**3. Acquire new locks** — acquire any lock keys not already held, in sorted order. The held set grows monotonically across sub-batches.

**4. Check append condition** — for each `(type, tag)` pair in this batch's condition, query `I#<type>#<tag>` with `ConsistentRead: true` for positions above the caller's `after` position. Exclude events carrying the current `txnId` (the transaction's own earlier sub-batches). If any remaining match → abort transaction, release all locks, throw `AppendConditionError`. Checks run in parallel.

**5. Reserve sequence range** — `UpdateItem _SEQ ADD value :count ReturnValues: UPDATED_OLD`. Events get positions `[old+1 … old+count]`.

**6. Write events** — `BatchWriteItem` in parallel, 25 items per call. All items carry `txnId`. Invisible while transaction is ACTIVE.

Repeat steps 2–6 for each sub-batch. The heartbeat keeps running throughout.

### Step 7: Commit (Fenced)

```
UpdateItem PK=_TXN, SK=<uuid> SET status = COMMITTED CONDITION: status = ACTIVE
```

On success, all events from all sub-batches become visible atomically. On failure (transaction was aborted), writer aborts.

### Step 8: Release

Stop heartbeat. Release all locks.

On **any error** in steps 2–7: stop heartbeat, abort transaction, release all locks.

## Append Flow (Unconditional)

No locks, no transaction record, no heartbeat:

```
1. ADD _SEQ :count → get start position
2. BatchWriteItem all events (no txnId — always visible)
```

## Read Flow

1. Query pointer partitions for matching events
2. Hydrate `E#` items via `BatchGetItem`, chunked to ≤100 keys (hard limit). Retry `UnprocessedKeys` with backoff.
3. Events without `txnId` → yield immediately (unconditional append)
4. Events with `txnId` → check transaction status. Cache committed IDs (immutable). `BatchGetItem` unknown transaction records (also ≤100). ACTIVE/ABORTED/missing → filter out.
5. Yield ordered by `position`

### Safe Checkpointing

Concurrent writers on different lock sets can commit out of order, creating gaps in the sequence where ACTIVE transactions have reserved positions but not yet committed. A projection that checkpoints past a gap would permanently miss those events when the transaction commits.

The read path already has the information to solve this: during step 4, it encounters exactly which ACTIVE transactions overlap with the current query — because only overlapping transactions have pointers in the partitions being read.

**Scoped reads** (type+tag, type-only, tag-only): the pointer partitions only contain events matching the query. If a meter import is in flight but the projection reads `CourseCreated` events, no meter events appear in the course partitions. The projection encounters no ACTIVE transactions and can safely checkpoint at the highest position it read. A long-running import of unrelated events causes zero delay.

**`Query.all()`** reads `A#` bucket partitions containing pointers to all events, so it encounters every ACTIVE transaction. Its safe checkpoint is `min(position) - 1` of all ACTIVE transaction events encountered during the read.

The safe checkpoint for any read is:
- **No ACTIVE transactions encountered** → checkpoint at max position read
- **ACTIVE transactions encountered** → `min(position) - 1` of events from those transactions

No global watermark item is needed. The checkpoint falls out naturally from the transaction status filtering already performed during the read.

### Query Routing

| Query shape | Index | Notes |
|-------------|-------|-------|
| Types + tags | `I#<type>#<firstTag>` | One query per type, filter remaining tags client-side |
| Types only | `IT#<type>` | One query per type, merge |
| Tags only | `IG#<firstTag>` | Filter remaining tags client-side |
| `Query.all()` | `A#<bucket>` | Sequential bucket reads |
| Multiple QueryItems | All above | Execute in parallel, merge + deduplicate by position |

Multi-tag queries pick the first tag for the partition key. In DCB patterns, tags are typically entity identifiers and highly selective.

## Recovery

Periodic process (Lambda on schedule or startup hook) handles crashed transactions:

1. Scan ACTIVE transactions where `createdAt` older than threshold (e.g. 60s)
2. Mark each ABORTED
3. **Delete orphaned items** — find items by `txnId` on the aborted transaction. Query lock items (`_LOCK#` where `txnId` matches) to identify affected scopes, then delete orphaned `E#`, `I#`, `IT#`, `IG#`, `A#` items carrying the aborted `txnId`.

Orphaned item deletion is required. Garbage pointers from aborted transactions accumulate in partitions and degrade read performance — readers fetch 1MB pages of pointers, discard most, yield almost nothing, paginate again. DynamoDB TTL (up to 48h) is too slow.

## Crash Safety

| Crash point | Events | Recovery |
|-------------|--------|----------|
| During lock acquisition | None | Recovery → ABORTED → steal |
| During condition check | None | Same |
| During sequence reservation | None | Same. Sequence gap harmless. |
| Mid-BatchWriteItem | Partial | Invisible (ACTIVE transaction). Recovery → ABORTED → steal. |
| After events, before commit | All written | Invisible until recovery → ABORTED. |
| After commit | All visible | **Success.** |

Every crash scenario is safe. Events are only visible when `status = COMMITTED`.

## Performance

Same-region Fargate + DynamoDB on-demand:

| Operation | Latency |
|-----------|---------|
| Unconditional append (any size) | 5ms seq + BatchWriteItem parallelism |
| Conditional append, small (1–5 events) | 15–25ms |
| Conditional append, large (1K events) | 100–500ms |
| Conditional append, very large (100K events) | 5–15s |
| Read, type+tag, single entity | 1–5ms |
| Read, `Query.all()` catch-up | ~2ms per 10K-event bucket |
| Heartbeat (any number of locks) | 1 write per interval |

## Open Questions

- **IT#/IG# indexes**: read-only conveniences. Dropping them halves write amplification (`tags + 2` vs `2 * tags + 3` items per event). Type-only and tag-only reads would fall back to `A#` bucket scans with client-side filtering. Evaluate against actual read patterns.
- **Lock lease tuning**: 30s lease / 10s heartbeat are defaults. Tune based on observed write latencies.
- **Sequence counter sharding**: single `_SEQ` supports ~1,000 increments/sec. Shard with range pre-allocation if measured as a bottleneck.
- **Large payloads**: 400KB DynamoDB item limit. Store payload in S3 and reference by key if approaching.

## Alternatives Considered

### Per-Lock Lease Expiry

Earlier design stored an absolute `leaseExpiry` timestamp on each lock item, enabling a single atomic conditional write to steal (`CONDITION: attribute_not_exists(txnId) OR leaseExpiry < :now`). Rejected for two reasons: (1) heartbeat must update every lock individually — thousands of writes per interval for large imports; (2) absolute timestamps introduce clock skew vulnerability — a client with a fast clock can prematurely steal a healthy writer's lock. The current design uses a fencing token on the transaction record with relative `leaseDuration`, eliminating both problems.

### Redis for Lock Management

Redis (Elasticache) offers ~1ms lock operations vs ~5ms for DynamoDB. Rejected: DynamoDB has 99.99% SLA with synchronous 3-AZ replication vs Redis's 99.9% with async replication and ~30s failover window. DynamoDB conditional writes have no split-brain risk. Lock latency is not the bottleneck — BatchWriteItem dominates. No additional infrastructure to operate.

### Optimistic Watermarks (No Locks)

Fine-grained `(type, tag)` watermarks updated inside `TransactWriteItems`. Rejected: `TransactWriteItems` is limited to 100 items, making large batch appends impossible without multiple transactions. Coarser type-level watermarks cause false conflicts between unrelated entities writing the same event type.

### Full-Data Indexes (vs Pointers)

Duplicating full event data in every index item eliminates the `BatchGetItem` hydration step (~3–5ms savings). Rejected: write amplification becomes `2 * tags + 3` copies of the full event data (~1KB each) instead of lightweight pointers (~50B). Single source of truth eliminates data consistency risk. Condition checks only need pointer existence, not event data.
