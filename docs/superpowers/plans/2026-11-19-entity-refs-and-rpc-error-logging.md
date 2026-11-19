# Entity References and RPC Error Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make entity references consistently accept id-or-name across MCP tools and make JSON-RPC validation failures visible in `make logs`.

**Architecture:** Add one resolver in `src/core/resolve.ts`; use it from every entity-referencing tool in `src/mcp/tools.ts`. Wrap `transport.send` in `src/server.ts` so outgoing JSON-RPC errors are logged with a sanitized argument shape, using a formatter in `src/mcp/log.ts`.

**Tech Stack:** TypeScript, better-sqlite3, Zod, MCP SDK, Vitest.

**Spec:** User requirements in session 2026-11-19 (entity refs, error messages, logging, tests, verification).

## Global Constraints

- Number = entity id; string = exact entity name. Never cross-guess.
- Keep all existing field names; no new reference fields; no breaking changes.
- `get.ids` and `get.names` are interchangeable; merge and de-duplicate.
- Observation refs stay numeric ids only; strings get: `observation refs must be numeric ids; call get to find the id`.
- Missing entity: `entity 7 not found in project X` / `entity 'foo' not found in project X`.
- Ambiguous name: error listing candidate ids; never pick one.
- No `type` alias for `relation_type`; keep it required.
- Tool descriptions stay short.
- Logged args contain keys and types only, never values.

## Review Focus

- Numeric-looking string must resolve as a name, never an id.
- A number must never resolve as a name.
- `remember` must not auto-create from a failed numeric reference.
- `get` with both `ids` and `names` must de-duplicate overlapping references.
- A JSON-RPC `-32602` must appear in logs without argument values.

## Tasks

### Task 1: Shared entity resolver
- Create `src/core/resolve.ts` with `type EntityRef = number | string`, `type ResolveResult = { ok: true; id: number } | { ok: false; error: string }`, and `resolveEntity(db, project, ref): ResolveResult`.
- Number queries by `id`, string queries by `name`, always scoped to project; 0 rows -> not-found message; >1 rows -> ambiguous message with candidate ids.
- Test: `tests/resolve.test.ts` with a temp DB covering id, name, missing id, missing name, ambiguity (temporary constraint violation simulated via a duplicate row inserted with constraints off is not needed — assert the branch with a mocked `.all()` result only if real setup cannot produce it).

### Task 2: Tool schemas and handlers
- Modify `src/mcp/tools.ts`: widen `relate.from/to`, `get.ids/names`, `forget.entityIds`, `remember.name` to `number | string`; keep `supersede` observation refs numeric at runtime with an actionable string error.
- Use `resolveEntity` everywhere; return `{ content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true }` on failure.
- `get`: merge `ids` + `names`, de-duplicate by resolved id.
- `remember`: never create from a failed numeric ref; return `observationIds` for all observations on the entity.
- `get`: already returns `observations[].id`; keep it.
- Test: `tests/integration.test.ts` — relate by ids, by names, mixed, non-existent id, remember observation ids, supersede string error.

### Task 3: JSON-RPC error logging
- Add `formatRpcError` to `src/mcp/log.ts`: timestamp, code, method, tool, `args={key:type,...}`, error message. No argument values.
- Wrap `transport.send` in `handleMcp` (`src/server.ts`) to log any outgoing JSON-RPC error using the incoming request body for tool name and argument shape.
- Test: unit test for sanitized formatting plus integration test that a `-32602` on `relate` appears in stderr with `tool=relate`, `from:number`, and no argument values.

### Task 4: Verification
- Run `make check` and `npx vitest run tests/integration.test.ts`; show real output.
- Rebuild/restart container; issue a real bad MCP call; show `make logs` output.
