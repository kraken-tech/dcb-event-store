import { DcbEvent, Query, SequencePosition } from "@dcb-es/event-store"
import { ParamManager, dbEventConverter } from "./utils"

export const appendSql = (
    events: DcbEvent[],
    failIfEventsMatch: Query | undefined,
    after: SequencePosition | undefined,
    tableName: string
): { statement: string; params: unknown[] } => {
    const params = new ParamManager()
    const formattedEvents = events.map(dbEventConverter.toDb)

    // Build VALUES clause for new events

    const valuesClause = formattedEvents
        .map(
            e =>
                //prettier-ignore
                `(
                    ${params.add(e.type)},
                    ${params.add(e.data)}::JSONB,
                    ${params.add(e.metadata)}::JSONB,
                    ${params.add(e.tags)}::text[]
                )`
        )
        .join(", ")

    // Build filtering clause if needed
    const filterClause = (): string => {
        if (!failIfEventsMatch) return ""

        const seqFilter = after ? `sequence_position > ${params.add(after.toString())}::bigint` : null

        if (failIfEventsMatch.isAll) {
            const conditions = seqFilter ? `WHERE ${seqFilter}` : ""
            return `
            WHERE NOT EXISTS (
                SELECT 1
                FROM ${tableName}
                ${conditions}
            )`
        }

        return `
            WHERE NOT EXISTS (
                ${failIfEventsMatch.items
                    .map(c => {
                        const conditions = [`tags @> ${params.add(c.tags?.values ?? [])}::text[]`]
                        if (seqFilter) conditions.push(seqFilter)
                        if (c.types?.length) {
                            conditions.unshift(`type IN (${c.types.map(t => params.add(t)).join(", ")})`)
                        }
                        return `
                            SELECT 1
                            FROM ${tableName}
                            WHERE ${conditions.join("\n                            AND ")}
                        `
                    })
                    .join(" UNION ALL ")}
            )`
    }

    // Main statement
    const statement = `
      WITH new_events (type, data, metadata, tags) AS (
        VALUES ${valuesClause}
      ),
      inserted AS (
        INSERT INTO ${tableName} (type, data, metadata, tags)
        SELECT type, data, metadata, tags
        FROM new_events
        ${filterClause()}
        RETURNING sequence_position, type, data, tags, "timestamp"
      )
      SELECT
        sequence_position,
        type,
        data,
        tags,
        to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "timestamp"
      FROM inserted;
    `

    return { statement, params: params.params }
}
