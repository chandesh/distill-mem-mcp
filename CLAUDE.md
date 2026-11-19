# distill-mem-mcp

Local MCP memory server. Hot path has no LLM calls. SQLite at `/data/distill.db` (container) or `./data/distill.db` (local).

- Entrypoint: `src/server.ts` (`--transport http|stdio`, env `DISTILL_TRANSPORT`).
- DB: `src/db/`. Schema version 1. Migrations in `schema.sql`.
- Tools: `src/mcp/tools.ts`. REST: `src/http/routes.ts`.
- Tests: `npm test` (vitest).
- Build: `npm run build` copies schema.sql to dist.
- Docker: bind-mounts `./data` to `/data`.
- Never modify user settings automatically; use `make hooks-print`.
