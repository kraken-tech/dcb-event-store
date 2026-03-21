import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb"

export class LockTimeoutError extends Error {
    constructor(lockKeys: string[]) {
        super(`Timed out acquiring locks: ${lockKeys.join(", ")}`)
        this.name = "LockTimeoutError"
    }
}

export type AcquireResult = {
    acquired: boolean
    stolenBatchIds: string[]
}

export type AcquireOptions = {
    leaseDurationMs: number
    timeoutMs?: number
    retryBaseMs?: number
}

export async function acquireLocks(
    client: DynamoDBDocumentClient,
    tableName: string,
    lockKeys: string[],
    batchId: string,
    options: AcquireOptions
): Promise<AcquireResult> {
    const { leaseDurationMs, timeoutMs = 30_000, retryBaseMs = 100 } = options
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
        const result = await tryAcquireAll(client, tableName, lockKeys, batchId, leaseDurationMs)
        if (result.acquired) return result

        // Failed — release any locks we got and retry
        await releaseAcquired(client, tableName, result.acquiredKeys, batchId)

        const remaining = deadline - Date.now()
        if (remaining <= 0) break

        const jitter = Math.random() * retryBaseMs
        await new Promise(resolve => setTimeout(resolve, Math.min(jitter + retryBaseMs, remaining)))
    }

    // Timeout — mark our batch FAILED
    await markBatchFailed(client, tableName, batchId)
    return { acquired: false, stolenBatchIds: [] }
}

async function tryAcquireAll(
    client: DynamoDBDocumentClient,
    tableName: string,
    lockKeys: string[],
    batchId: string,
    leaseDurationMs: number
): Promise<AcquireResult & { acquiredKeys: string[] }> {
    const now = Date.now()
    const expiry = now + leaseDurationMs
    const stolenBatchIds: string[] = []
    const acquiredKeys: string[] = []

    const results = await Promise.allSettled(
        lockKeys.map(async key => {
            const result = await client.send(
                new UpdateCommand({
                    TableName: tableName,
                    Key: { PK: `_LOCK#${key}`, SK: `_LOCK#${key}` },
                    UpdateExpression: "SET batchId = :bid, leaseExpiry = :exp",
                    ConditionExpression: "attribute_not_exists(batchId) OR leaseExpiry < :now",
                    ExpressionAttributeValues: { ":bid": batchId, ":exp": expiry, ":now": now },
                    ReturnValues: "ALL_OLD"
                })
            )
            return { key, oldAttributes: result.Attributes }
        })
    )

    let allSucceeded = true
    for (const result of results) {
        if (result.status === "fulfilled") {
            acquiredKeys.push(result.value.key)
            const oldBatchId = result.value.oldAttributes?.batchId as string | undefined
            if (oldBatchId && oldBatchId !== batchId) {
                stolenBatchIds.push(oldBatchId)
            }
        } else {
            allSucceeded = false
        }
    }

    if (allSucceeded) {
        // Mark stolen batches as FAILED (fencing mechanism 1)
        await Promise.all([...new Set(stolenBatchIds)].map(id => markBatchFailed(client, tableName, id)))
        return { acquired: true, stolenBatchIds: [...new Set(stolenBatchIds)], acquiredKeys }
    }

    return { acquired: false, stolenBatchIds: [], acquiredKeys }
}

async function releaseAcquired(
    client: DynamoDBDocumentClient,
    tableName: string,
    keys: string[],
    batchId: string
): Promise<void> {
    await Promise.all(keys.map(key => releaseSingleLock(client, tableName, key, batchId)))
}

async function releaseSingleLock(
    client: DynamoDBDocumentClient,
    tableName: string,
    lockKey: string,
    batchId: string
): Promise<void> {
    try {
        await client.send(
            new UpdateCommand({
                TableName: tableName,
                Key: { PK: `_LOCK#${lockKey}`, SK: `_LOCK#${lockKey}` },
                UpdateExpression: "REMOVE batchId, leaseExpiry",
                ConditionExpression: "batchId = :bid",
                ExpressionAttributeValues: { ":bid": batchId }
            })
        )
    } catch (e: unknown) {
        if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e
        // Lock held by someone else or already released — fine
    }
}

export async function releaseLocks(
    client: DynamoDBDocumentClient,
    tableName: string,
    lockKeys: string[],
    batchId: string
): Promise<void> {
    await Promise.all(lockKeys.map(key => releaseSingleLock(client, tableName, key, batchId)))
}

export type HeartbeatHandle = {
    stop: () => void
    invalidated: Promise<void>
}

export type HeartbeatOptions = {
    intervalMs: number
    leaseDurationMs: number
}

export function startHeartbeat(
    client: DynamoDBDocumentClient,
    tableName: string,
    lockKeys: string[],
    batchId: string,
    options: HeartbeatOptions
): HeartbeatHandle {
    let stopped = false
    let resolveInvalidated: () => void
    let timer: ReturnType<typeof setInterval> | undefined

    const invalidated = new Promise<void>(resolve => {
        resolveInvalidated = resolve
    })

    const tick = async () => {
        if (stopped) return
        const newExpiry = Date.now() + options.leaseDurationMs
        try {
            await Promise.all(
                lockKeys.map(key =>
                    client.send(
                        new UpdateCommand({
                            TableName: tableName,
                            Key: { PK: `_LOCK#${key}`, SK: `_LOCK#${key}` },
                            UpdateExpression: "SET leaseExpiry = :exp",
                            ConditionExpression: "batchId = :bid",
                            ExpressionAttributeValues: { ":exp": newExpiry, ":bid": batchId }
                        })
                    )
                )
            )
        } catch (e: unknown) {
            if ((e as { name?: string }).name === "ConditionalCheckFailedException") {
                stopped = true
                if (timer) clearInterval(timer)
                resolveInvalidated()
                return
            }
            throw e
        }
    }

    timer = setInterval(tick, options.intervalMs)

    return {
        stop: () => {
            if (stopped) return
            stopped = true
            if (timer) clearInterval(timer)
        },
        invalidated
    }
}

async function markBatchFailed(
    client: DynamoDBDocumentClient,
    tableName: string,
    batchId: string
): Promise<void> {
    try {
        await client.send(
            new UpdateCommand({
                TableName: tableName,
                Key: { PK: `_BATCH#${batchId}`, SK: `_BATCH#${batchId}` },
                UpdateExpression: "SET #s = :failed",
                ConditionExpression: "#s = :pending",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { ":failed": "FAILED", ":pending": "PENDING" }
            })
        )
    } catch (e: unknown) {
        if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e
        // Already COMMITTED or FAILED — fine
    }
}
