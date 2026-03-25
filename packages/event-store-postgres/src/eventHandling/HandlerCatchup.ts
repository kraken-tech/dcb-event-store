import { EventHandler, EventStore, Query, SequencePosition, Tags } from "@dcb-es/event-store"
import { Pool, PoolClient } from "pg"
import { ensureHandlersInstalled, registerhandlers } from "./ensureHandlersInstalled"
import { PostgresPosition } from "../eventStore/PostgresPosition"

export type HandlerCheckPoints = Record<string, SequencePosition>

export class HandlerCatchup {
    private tableName: string
    constructor(
        private client: Pool | PoolClient,
        private eventStore: EventStore,
        tablePrefix?: string
    ) {
        this.tableName = tablePrefix ? `${tablePrefix}_handler_bookmarks` : "_handler_bookmarks"
    }

    async ensureInstalled(handlerIds: string[]): Promise<void> {
        await ensureHandlersInstalled(this.client, handlerIds, this.tableName)
    }

    async registerHandlers(handlerIds: string[]): Promise<void> {
        await registerhandlers(this.client, handlerIds, this.tableName)
    }

    async catchupHandlers(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handlers: Record<string, EventHandler<any, any>>
    ) {
        const currentCheckPoints = await this.lockHandlers(handlers, this.tableName)

        await Promise.all(
            Object.entries(handlers).map(
                async ([handlerId, handler]) =>
                    (currentCheckPoints[handlerId] = await this.catchupHandler(handler, currentCheckPoints[handlerId]))
            )
        )
        await this.updateBookmarksAndReleaseLocks(currentCheckPoints)
    }

    private async lockHandlers(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handlers: Record<string, EventHandler<any, any>>,
        tableName: string
    ): Promise<HandlerCheckPoints> {
        try {
            const selectResult = await this.client.query(
                `
                SELECT handler_id, last_sequence_position
                FROM ${tableName}
                WHERE handler_id = ANY($1::text[])
                FOR UPDATE NOWAIT;`,
                [Object.keys(handlers)]
            )

            const result = Object.keys(handlers).reduce((acc, handlerId) => {
                const rawPosition = selectResult.rows.find(row => row.handler_id === handlerId)?.last_sequence_position
                if (rawPosition !== undefined) {
                    return {
                        ...acc,
                        [handlerId]: new PostgresPosition(parseInt(`${rawPosition}`))
                    }
                } else {
                    throw new Error(`Failed to retrieve sequence number for handler ${handlerId}`)
                }
            }, {})

            return result
        } catch (error) {
            const err = error as { code?: string }
            if (err.code === "55P03") {
                throw new Error("Could not obtain lock as it is already locked by another process")
            }
            throw error
        }
    }

    private async updateBookmarksAndReleaseLocks(locks: HandlerCheckPoints): Promise<void> {
        if (Object.values(locks).some(lock => !lock)) throw new Error("Sequence number is required to commit")

        const updateValues = Object.keys(locks)
            .map((_, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::bigint)`)
            .join(", ")

        const updateParams = Object.entries(locks).flatMap(([handlerId, position]) => [
            handlerId,
            (position as PostgresPosition).value
        ])

        const updateQuery = `
            UPDATE ${this.tableName} SET last_sequence_position = v.last_sequence_position
            FROM (VALUES ${updateValues}) AS v(handler_id, last_sequence_position)
            WHERE ${this.tableName}.handler_id = v.handler_id;`

        await this.client.query(updateQuery, updateParams)
    }

    private async catchupHandler(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: EventHandler<any, any>,
        currentPosition: SequencePosition,
        toSequencePosition?: SequencePosition
    ) {
        if (!toSequencePosition) {
            const lastEventInStore = (await this.eventStore.read(Query.all(), { backwards: true, limit: 1 }).next())
                .value
            if (!lastEventInStore) return currentPosition
            toSequencePosition = lastEventInStore.position
        }

        const query = Query.fromItems([{ types: Object.keys(handler.when) as string[], tags: Tags.createEmpty() }])
        for await (const event of this.eventStore.read(query, { afterPosition: currentPosition })) {
            if (toSequencePosition && event.position.isAfter(toSequencePosition)) {
                break
            }
            if (handler.when[event.event.type]) await handler.when[event.event.type](event)

            currentPosition = event.position
        }
        return currentPosition
    }
}
