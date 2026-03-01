# DCB Event Sourced

Implementation of the Dynamic Consistency Boundary (DCB) pattern for Node.js/TypeScript, based on Sara Pellegrini's design.

## Project Structure

Monorepo managed with **Lerna** and **Yarn workspaces**.

### Packages
- `packages/event-store` (`@dcb-es/event-store`) — Core event store abstractions, in-memory implementation, event handling (decision models, tag matching)
- `packages/event-store-postgres` (`@dcb-es/event-store-postgres`) — Postgres implementation using `pg`, tests use `testcontainers`

### Examples
- `examples/course-manager-cli` — Simple CLI example (Course/Students domain)
- `examples/course-manager-cli-with-readmodel` — Extended example with read models

### Shared Test Infrastructure
- `test/vitest.globalSetup.ts` — Starts/stops a testcontainers Postgres instance, shares connection URI via `process.env.__PG_CONNECTION_URI`
- `test/testPgDbPool.ts` — Creates isolated test databases per test suite; imported via `@test` Vite resolve alias

## Commands

- `npm test` — Run all tests via Lerna (each package uses `vitest run`)
- `npm run build` — Build all packages (must build before running dependent package tests)
- `npm run lint` / `npm run lint-fix` — ESLint across all packages
- Per-package: `cd packages/<name> && npm test`

## Tech Stack

- TypeScript, Vitest, ESLint + Prettier
- Postgres tests require Docker (testcontainers)
- Dependencies: luxon (dates), uuid, pg

## Key Concepts

- **EventStore**: Interface for querying and appending events with optimistic concurrency
- **Tags**: Key-value pairs on events used for filtering/querying
- **Query**: Defines which events to fetch (by event types and tag filters)
- **Decision Model** (`buildDecisionModel`): Builds state from events for command validation
- **Event Handlers**: Projections/process managers that react to events
- **SequencePosition**: Global ordering of events, used for concurrency checks
