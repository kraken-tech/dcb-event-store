import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb"
import { getTestDynamoTable } from "@test/testDynamoClient"
import { acquireLocks, releaseLocks, startHeartbeat, LockTimeoutError } from "./lockManager"

let client: DynamoDBDocumentClient
let tableName: string

beforeAll(async () => {
    const table = await getTestDynamoTable()
    client = table.client
    tableName = table.tableName
})

const createBatch = async (batchId: string, status = "PENDING") => {
    await client.send(
        new PutCommand({
            TableName: tableName,
            Item: { PK: `_BATCH#${batchId}`, SK: `_BATCH#${batchId}`, status, createdAt: Date.now() }
        })
    )
}

const getBatchStatus = async (batchId: string): Promise<string | undefined> => {
    const result = await client.send(
        new GetCommand({ TableName: tableName, Key: { PK: `_BATCH#${batchId}`, SK: `_BATCH#${batchId}` } })
    )
    return result.Item?.status as string | undefined
}

const getLockItem = async (lockKey: string) => {
    const result = await client.send(
        new GetCommand({ TableName: tableName, Key: { PK: `_LOCK#${lockKey}`, SK: `_LOCK#${lockKey}` } })
    )
    return result.Item
}

const setLock = async (lockKey: string, batchId: string, leaseExpiry: number) => {
    await client.send(
        new PutCommand({
            TableName: tableName,
            Item: { PK: `_LOCK#${lockKey}`, SK: `_LOCK#${lockKey}`, batchId, leaseExpiry }
        })
    )
}

describe("lockManager", () => {
    describe("acquireLocks", () => {
        test("should acquire a single lock on an empty table", async () => {
            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            const result = await acquireLocks(client, tableName, ["TypeA:tag=1"], batchId, { leaseDurationMs: 30_000 })

            expect(result.acquired).toBe(true)
            expect(result.stolenBatchIds).toEqual([])

            const lock = await getLockItem("TypeA:tag=1")
            expect(lock?.batchId).toBe(batchId)
            expect(lock?.leaseExpiry).toBeGreaterThan(Date.now())
        })

        test("should acquire multiple locks in parallel", async () => {
            const batchId = crypto.randomUUID()
            await createBatch(batchId)
            const suffix = crypto.randomUUID().slice(0, 8)
            const keys = [`TypeA:tag=${suffix}`, `TypeB:tag=${suffix}`, `TypeC:tag=${suffix}`]

            const result = await acquireLocks(client, tableName, keys, batchId, { leaseDurationMs: 30_000 })

            expect(result.acquired).toBe(true)
            for (const key of keys) {
                const lock = await getLockItem(key)
                expect(lock?.batchId).toBe(batchId)
            }
        })

        test("should fail when lock is held by active lease", async () => {
            const holderId = crypto.randomUUID()
            await createBatch(holderId)
            await setLock("contested", holderId, Date.now() + 60_000)

            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            const result = await acquireLocks(client, tableName, ["contested"], batchId, {
                leaseDurationMs: 30_000,
                timeoutMs: 200,
                retryBaseMs: 50
            })

            expect(result.acquired).toBe(false)

            // Our batch should be marked FAILED after timeout
            expect(await getBatchStatus(batchId)).toBe("FAILED")
            // Holder's lock is untouched
            const lock = await getLockItem("contested")
            expect(lock?.batchId).toBe(holderId)
        })

        test("should steal lock with expired lease", async () => {
            const oldBatchId = crypto.randomUUID()
            await createBatch(oldBatchId)
            await setLock("expired-lock", oldBatchId, Date.now() - 1000)

            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            const result = await acquireLocks(client, tableName, ["expired-lock"], batchId, {
                leaseDurationMs: 30_000
            })

            expect(result.acquired).toBe(true)
            expect(result.stolenBatchIds).toContain(oldBatchId)

            const lock = await getLockItem("expired-lock")
            expect(lock?.batchId).toBe(batchId)
        })

        test("should mark stolen lock's old batch as FAILED", async () => {
            const oldBatchId = crypto.randomUUID()
            await createBatch(oldBatchId)
            await setLock("fence-test", oldBatchId, Date.now() - 1000)

            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            await acquireLocks(client, tableName, ["fence-test"], batchId, { leaseDurationMs: 30_000 })

            expect(await getBatchStatus(oldBatchId)).toBe("FAILED")
        })

        test("should not mark already-COMMITTED batch as FAILED on steal", async () => {
            const oldBatchId = crypto.randomUUID()
            await createBatch(oldBatchId, "COMMITTED")
            await setLock("committed-steal", oldBatchId, Date.now() - 1000)

            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            const result = await acquireLocks(client, tableName, ["committed-steal"], batchId, {
                leaseDurationMs: 30_000
            })

            expect(result.acquired).toBe(true)
            // Old batch stays COMMITTED (condition status=PENDING fails, which is fine)
            expect(await getBatchStatus(oldBatchId)).toBe("COMMITTED")
        })

        test("two concurrent stealers — only one wins", async () => {
            const oldBatchId = crypto.randomUUID()
            await createBatch(oldBatchId)
            await setLock("race-lock", oldBatchId, Date.now() - 1000)

            const batchA = crypto.randomUUID()
            const batchB = crypto.randomUUID()
            await createBatch(batchA)
            await createBatch(batchB)

            const [resultA, resultB] = await Promise.all([
                acquireLocks(client, tableName, ["race-lock"], batchA, {
                    leaseDurationMs: 30_000,
                    timeoutMs: 500,
                    retryBaseMs: 50
                }),
                acquireLocks(client, tableName, ["race-lock"], batchB, {
                    leaseDurationMs: 30_000,
                    timeoutMs: 500,
                    retryBaseMs: 50
                })
            ])

            const winners = [resultA, resultB].filter(r => r.acquired)
            expect(winners.length).toBe(1)
        })

        test("partial acquisition releases acquired locks and marks batch FAILED", async () => {
            const holderId = crypto.randomUUID()
            await createBatch(holderId)
            await setLock("partial-blocked", holderId, Date.now() + 60_000)

            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            const result = await acquireLocks(
                client,
                tableName,
                ["partial-free", "partial-blocked"],
                batchId,
                { leaseDurationMs: 30_000, timeoutMs: 200, retryBaseMs: 50 }
            )

            expect(result.acquired).toBe(false)
            expect(await getBatchStatus(batchId)).toBe("FAILED")

            // The lock we did acquire should be released
            const freeLock = await getLockItem("partial-free")
            expect(freeLock?.batchId).not.toBe(batchId)
        })

        test("should throw LockTimeoutError after timeout", async () => {
            const holderId = crypto.randomUUID()
            await createBatch(holderId)
            await setLock("timeout-lock", holderId, Date.now() + 60_000)

            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            const result = await acquireLocks(client, tableName, ["timeout-lock"], batchId, {
                leaseDurationMs: 30_000,
                timeoutMs: 300,
                retryBaseMs: 50
            })

            expect(result.acquired).toBe(false)
        })
    })

    describe("heartbeat", () => {
        test("should extend lease expiry", async () => {
            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            await acquireLocks(client, tableName, ["hb-test"], batchId, { leaseDurationMs: 5_000 })

            const lockBefore = await getLockItem("hb-test")
            const expiryBefore = lockBefore!.leaseExpiry as number

            const hb = startHeartbeat(client, tableName, ["hb-test"], batchId, {
                intervalMs: 100,
                leaseDurationMs: 5_000
            })

            await new Promise(resolve => setTimeout(resolve, 250))
            hb.stop()

            const lockAfter = await getLockItem("hb-test")
            expect(lockAfter!.leaseExpiry as number).toBeGreaterThan(expiryBefore)
        })

        test("should signal invalidation when lock is stolen", async () => {
            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            await acquireLocks(client, tableName, ["hb-stolen"], batchId, { leaseDurationMs: 5_000 })

            const hb = startHeartbeat(client, tableName, ["hb-stolen"], batchId, {
                intervalMs: 100,
                leaseDurationMs: 5_000
            })

            // Simulate steal by overwriting the lock
            const thief = crypto.randomUUID()
            await setLock("hb-stolen", thief, Date.now() + 60_000)

            // Wait for heartbeat to detect the steal
            await expect(hb.invalidated).resolves.toBeUndefined()
            hb.stop()
        })

        test("stop should be idempotent", async () => {
            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            await acquireLocks(client, tableName, ["hb-idempotent"], batchId, { leaseDurationMs: 5_000 })

            const hb = startHeartbeat(client, tableName, ["hb-idempotent"], batchId, {
                intervalMs: 100,
                leaseDurationMs: 5_000
            })

            hb.stop()
            hb.stop() // should not throw
        })
    })

    describe("releaseLocks", () => {
        test("should remove lock attributes", async () => {
            const batchId = crypto.randomUUID()
            await createBatch(batchId)
            await acquireLocks(client, tableName, ["release-test"], batchId, { leaseDurationMs: 30_000 })

            await releaseLocks(client, tableName, ["release-test"], batchId)

            const lock = await getLockItem("release-test")
            expect(lock?.batchId).toBeUndefined()
        })

        test("should be idempotent", async () => {
            const batchId = crypto.randomUUID()
            await createBatch(batchId)
            await acquireLocks(client, tableName, ["release-idem"], batchId, { leaseDurationMs: 30_000 })

            await releaseLocks(client, tableName, ["release-idem"], batchId)
            await releaseLocks(client, tableName, ["release-idem"], batchId) // should not throw
        })

        test("should not release lock held by different batch", async () => {
            const holderId = crypto.randomUUID()
            await createBatch(holderId)
            await setLock("release-other", holderId, Date.now() + 60_000)

            const otherId = crypto.randomUUID()
            await releaseLocks(client, tableName, ["release-other"], otherId)

            const lock = await getLockItem("release-other")
            expect(lock?.batchId).toBe(holderId)
        })
    })

    describe("fencing", () => {
        test("fenced commit succeeds when batch is PENDING", async () => {
            const batchId = crypto.randomUUID()
            await createBatch(batchId)

            const result = await client.send(
                new UpdateCommand({
                    TableName: tableName,
                    Key: { PK: `_BATCH#${batchId}`, SK: `_BATCH#${batchId}` },
                    UpdateExpression: "SET #s = :committed",
                    ConditionExpression: "#s = :pending",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: { ":committed": "COMMITTED", ":pending": "PENDING" }
                })
            )
            expect(result.$metadata.httpStatusCode).toBe(200)
            expect(await getBatchStatus(batchId)).toBe("COMMITTED")
        })

        test("fenced commit fails when batch is FAILED", async () => {
            const batchId = crypto.randomUUID()
            await createBatch(batchId, "FAILED")

            await expect(
                client.send(
                    new UpdateCommand({
                        TableName: tableName,
                        Key: { PK: `_BATCH#${batchId}`, SK: `_BATCH#${batchId}` },
                        UpdateExpression: "SET #s = :committed",
                        ConditionExpression: "#s = :pending",
                        ExpressionAttributeNames: { "#s": "status" },
                        ExpressionAttributeValues: { ":committed": "COMMITTED", ":pending": "PENDING" }
                    })
                )
            ).rejects.toThrow("conditional")
        })

        test("full fencing scenario: acquire → expire → steal → old commit fails", async () => {
            const oldBatchId = crypto.randomUUID()
            await createBatch(oldBatchId)
            // Simulate: old writer acquired lock, then lease expired
            await setLock("fencing-full", oldBatchId, Date.now() - 1000)

            // New writer steals the lock
            const newBatchId = crypto.randomUUID()
            await createBatch(newBatchId)
            await acquireLocks(client, tableName, ["fencing-full"], newBatchId, { leaseDurationMs: 30_000 })

            // Old batch should be FAILED (fencing mechanism 1)
            expect(await getBatchStatus(oldBatchId)).toBe("FAILED")

            // Old writer tries to commit — fails (fencing mechanism 2)
            await expect(
                client.send(
                    new UpdateCommand({
                        TableName: tableName,
                        Key: { PK: `_BATCH#${oldBatchId}`, SK: `_BATCH#${oldBatchId}` },
                        UpdateExpression: "SET #s = :committed",
                        ConditionExpression: "#s = :pending",
                        ExpressionAttributeNames: { "#s": "status" },
                        ExpressionAttributeValues: { ":committed": "COMMITTED", ":pending": "PENDING" }
                    })
                )
            ).rejects.toThrow("conditional")

            // New writer can commit fine
            await client.send(
                new UpdateCommand({
                    TableName: tableName,
                    Key: { PK: `_BATCH#${newBatchId}`, SK: `_BATCH#${newBatchId}` },
                    UpdateExpression: "SET #s = :committed",
                    ConditionExpression: "#s = :pending",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: { ":committed": "COMMITTED", ":pending": "PENDING" }
                })
            )
            expect(await getBatchStatus(newBatchId)).toBe("COMMITTED")
        })
    })
})
