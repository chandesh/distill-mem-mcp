# distill-mem-mcp

An MCP server that helps lower token cost for agent memory. Free, open source, runs entirely on your machine. Follows the `@modelcontextprotocol/server-memory` data model (entities, relations, observations) with compression, ranking, decay, and a strict token budget.

## Quickstart

```bash
make init
make up
make health
make mcp-add
make hooks-print
```

Then merge the printed hook snippet into `~/.claude/settings.json` or `.claude/settings.json`.

## Architecture

- Single Node process, HTTP on `127.0.0.1:8787` (container binds `0.0.0.0:8787`, published localhost-only).
- SQLite (WAL) persisted in `./data` (bind-mounted).
- MCP endpoint at `/mcp`. REST: `/health`, `/ingest`, `/context`, `/stats`.

## Token-cost philosophy

- Hot path makes no LLM calls.
- `search` returns a compact index only; full details via `get`.
- `/context` hard-enforces a token budget (default 1200), truncating by rank.
- Optional LLM consolidation is stubbed (`make consolidate`).

## Tools

`remember`, `relate`, `search`, `get`, `supersede`, `forget`, `stats`.

## Backup / restore

```bash
make backup
make restore FILE=./backups/distill-<timestamp>.db
```

## Stdio mode

```bash
docker run -i --rm -v $(pwd)/data:/data distill-mem-mcp --transport stdio
```

## Troubleshooting

- Docker not running: start Docker Desktop.
- Port in use: set `DISTILL_PORT` in `.env`.
- DB locked: stop container (`make down`) before editing.
- Data persists in `./data`; `make nuke` deletes it (with confirmation).

## Development

```bash
make dev        # hot reload
make test
make check
```