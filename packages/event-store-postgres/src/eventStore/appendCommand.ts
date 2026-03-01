import { DcbEvent, Query, SequencePosition } from "@dcb-es/event-store"
import { ParamManager, dbEventConverter } from "./utils"

export const appendSql = (
    events: DcbEvent[],
    query: Query | undefined,
    expectedCeiling: SequencePosition | undefined,
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
        if (!query || !expectedCeiling) return ""
        const maxSeqNoParam = params.add(expectedCeiling.value)

        if (query.isAll) {
            return `
            WHERE NOT EXISTS (
                SELECT 1
                FROM ${tableName}
                WHERE sequence_position > ${maxSeqNoParam}::bigint
            )`
        }

        return `
            WHERE NOT EXISTS (
                ${query.items
                    .map(c => {
                        const conditions = [
                            `tags @> ${params.add(c.tags?.values ?? [])}::text[]`,
                            `sequence_position > ${maxSeqNoParam}::bigint`
                        ]
                        if (c.eventTypes?.length) {
                            conditions.unshift(`type IN (${c.eventTypes.map(t => params.add(t)).join(", ")})`)
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
