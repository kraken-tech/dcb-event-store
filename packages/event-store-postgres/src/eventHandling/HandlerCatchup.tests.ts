import { Pool, PoolClient } from "pg"
import { v4 as uuid } from "uuid"
import { Tags } from "@dcb-es/event-store"
import { HandlerCatchup } from "./HandlerCatchup"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { PostgresEventStore } from "../eventStore/PostgresEventStore"

describe("UpdatePostgresHandlers tests", () => {
    let pool: Pool
    let client: PoolClient
    let eventStore: PostgresEventStore
    let handlerCatchup: HandlerCatchup
    const handlers = {
        [uuid().toString()]: { when: {} },
        [uuid().toString()]: { when: {} }
    }

    beforeAll(async () => {
        pool = await getTestPgDatabasePool()
        eventStore = new PostgresEventStore(pool)
        handlerCatchup = new HandlerCatchup(pool, eventStore)
        await eventStore.ensureInstalled()
        await handlerCatchup.ensureInstalled(Object.keys(handlers))
    })
    beforeEach(async () => {
        client = await pool.connect()
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        eventStore = new PostgresEventStore(client)
        handlerCatchup = new HandlerCatchup(client, eventStore)
    })

    afterEach(async () => {
        await client.query("COMMIT")
        client.release()
        await pool.query("TRUNCATE table events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
        await pool.query("UPDATE _handler_bookmarks SET last_sequence_position = 0")
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    test("install worked ok", async () => {
        await handlerCatchup.catchupHandlers(handlers)
        const result = await pool.query(`SELECT * FROM _handler_bookmarks`)
        expect(result.rows).toHaveLength(2)
        expect(result.rows[0].handler_id).toBe(Object.keys(handlers)[0])
        expect(result.rows[1].handler_id).toBe(Object.keys(handlers)[1])
    })

    test("register handlers worked ok", async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS _handler_bookmarks (
                handler_id TEXT PRIMARY KEY,
                last_sequence_position BIGINT
            );`)
        await handlerCatchup.registerHandlers(Object.keys(handlers))
        const result = await pool.query(`SELECT * FROM _handler_bookmarks`)
        expect(result.rows).toHaveLength(2)
        expect(result.rows[0].handler_id).toBe(Object.keys(handlers)[0])
        expect(result.rows[1].handler_id).toBe(Object.keys(handlers)[1])
    })

    test("should successfully queue multiple parallel requests", async () => {
        await eventStore.append({ type: "testEvent1", data: {}, metadata: {}, tags: Tags.createEmpty() })
        const promises = Array.from({ length: 10 }, () => handlerCatchup.catchupHandlers(handlers))
        await Promise.all(promises)
        const result = await pool.query(`SELECT * FROM _handler_bookmarks`)
        expect(result.rows).toHaveLength(2)
        expect(result.rows[0].handler_id).toBe(Object.keys(handlers)[0])
        expect(result.rows[1].handler_id).toBe(Object.keys(handlers)[1])
    })

    test("should handle catchup with empty store without error", async () => {
        await handlerCatchup.catchupHandlers(handlers)
        const result = await pool.query(`SELECT * FROM _handler_bookmarks`)
        expect(result.rows).toHaveLength(2)
        expect(Number(result.rows[0].last_sequence_position)).toBe(0)
        expect(Number(result.rows[1].last_sequence_position)).toBe(0)
    })

    describe("event processing", () => {
        const handlerId = uuid().toString()
        let processedCount: number

        beforeAll(async () => {
            await pool.query(
                `INSERT INTO _handler_bookmarks (handler_id, last_sequence_position) VALUES ($1, 0) ON CONFLICT DO NOTHING`,
                [handlerId]
            )
        })

        beforeEach(() => {
            processedCount = 0
        })

        test("should process events and advance bookmark position", async () => {
            const trackingHandlers = {
                [handlerId]: {
                    when: {
                        testEvent1: async () => {
                            processedCount++
                        }
                    }
                }
            }
            await eventStore.append({ type: "testEvent1", data: {}, metadata: {}, tags: Tags.createEmpty() })
            await eventStore.append({ type: "testEvent1", data: {}, metadata: {}, tags: Tags.createEmpty() })
            await handlerCatchup.catchupHandlers(trackingHandlers)
            expect(processedCount).toBe(2)
        })

        test("should not reprocess already-seen events on second catchup", async () => {
            const trackingHandlers = {
                [handlerId]: {
                    when: {
                        testEvent1: async () => {
                            processedCount++
                        }
                    }
                }
            }
            await eventStore.append({ type: "testEvent1", data: {}, metadata: {}, tags: Tags.createEmpty() })
            await handlerCatchup.catchupHandlers(trackingHandlers)
            expect(processedCount).toBe(1)

            processedCount = 0
            await handlerCatchup.catchupHandlers(trackingHandlers)
            expect(processedCount).toBe(0)
        })
    })
})
