import { Query, QueryItem, ReadOptions } from "@dcb-es/event-store"
import { ParamManager } from "./utils"
import { PostgresPosition } from "./PostgresPosition"

export const readSqlWithCursor = (query: Query, tableName: string, options?: ReadOptions) => {
    const { sql, params } = readSql(query, tableName, options)
    const cursorName = `event_cursor_${Math.random().toString(36).substring(7)}`
    return {
        sql: `DECLARE ${cursorName} CURSOR FOR ${sql}`,
        params,
        cursorName
    }
}

const readSql = (query: Query, tableName: string, options?: ReadOptions) => {
    const pm = new ParamManager()

    const sql = `
    SELECT
      e.sequence_position,
      e.type,
      e.data,
      e.metadata,
      e.tags,
      to_char(e."timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "timestamp"
    FROM ${tableName} e
    ${query.isAll ? "" : readCriteriaJoin(query, pm, tableName, options)}
    ${whereClause([afterFilter(pm, "e", options)])}
    ORDER BY e.sequence_position ${options?.backwards ? "DESC" : ""}
    ${options?.limit ? `LIMIT ${options.limit}` : ""};
  `
    return { sql, params: pm.params }
}

const notEmpty = (s: string): boolean => s !== null && s.trim() !== ""

const tagFilterSnip = (pm: ParamManager, c: QueryItem): string =>
    c.tags && c.tags.length ? `tags && ${pm.add(c.tags.values)}::text[]` : ""

const afterFilter = (pm: ParamManager, tableAlias: string, options?: ReadOptions): string =>
    options?.after
        ? `${tableAlias ? `${tableAlias}.` : ""}sequence_position ${
              options.backwards ? "<" : ">"
          } ${pm.add((options.after as PostgresPosition).value)}`
        : ""

const typesFilter = (c: QueryItem, pm: ParamManager): string =>
    c.types?.length ? `type IN (${c.types.map(t => pm.add(t)).join(", ")})` : ""

const getFilterString = (c: QueryItem, pm: ParamManager, options?: ReadOptions): string => {
    const filters = [typesFilter(c, pm), tagFilterSnip(pm, c), afterFilter(pm, "", options)]
    return whereClause(filters)
}

export const readCriteriaJoin = (query: Query, pm: ParamManager, tableName: string, options?: ReadOptions): string => {
    if (query.isAll) return ""
    const criteriaQueries = query.items.map(
        c => `
      SELECT
         sequence_position
      FROM ${tableName}
      ${getFilterString(c, pm, options)}
    `
    )
    return `
    INNER JOIN (
      SELECT ec.sequence_position
      FROM (
        ${criteriaQueries.join(" UNION ALL ")}
      ) ec
      GROUP BY ec.sequence_position
    ) ec ON ec.sequence_position = e.sequence_position
  `
}

const whereClause = (queryParts: string[]): string => {
    const parts = queryParts.filter(notEmpty)
    return parts.length ? `WHERE ${parts.join(" AND ")}` : ""
}
