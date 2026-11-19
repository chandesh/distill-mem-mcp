# Design

## SDK API used (v1, @modelcontextprotocol/sdk 1.32.2)

- `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`: constructor `{ name, version }`, `registerTool(name, { description, inputSchema }, handler)`, `connect(transport)`, `close()`.
- `StdioServerTransport` from `.../server/stdio.js`.
- `StreamableHTTPServerTransport` from `.../server/streamableHttp.js`: stateless mode by omitting `sessionIdGenerator`; `handleRequest(req, res, parsedBody)`.
- Client: `Client` + `StreamableHTTPClientTransport`.
- Tool input schemas use `zod` (v4 compatible). Tool handlers return `{ content: [{ type: 'text', text }] }`.

We intentionally use the v1 package (the one named in the task) rather than the newer split v2 packages, for protocol compatibility with Claude Code and a single cohesive dependency.

## Ranking formula

Search score (entities):

```
bm25Rel = 1 / (1 + |bm25|)
score = bm25Rel*0.35 + recency*0.2 + importance*0.2 + accessFreq*0.1 + decay*0.1 + pinnedBoost(0.25 if pinned)
accessFreq = min(1, access_count/20)
recency = 1/(1+daysSinceLastAccess)
decay = 0.5^(days/halfLife), halfLife = 7 + importance*53 days
```

Context ranking uses importance*0.35 + decay*0.25 + accessFreq*0.2 + recency*0.1 + pinned 0.1.

## Token budget

`buildContextMarkdown` accumulates sections (pinned facts, ranked index, latest session summary) and stops adding items when the estimated token count would exceed the budget. Estimator: ~4 chars/token + word overhead.

## Storage

SQLite, WAL mode, foreign keys. FTS5 virtual tables with triggers. Scope by project. DB at `/data/distill.db` in container, `./data/distill.db` locally.

## Dependencies

- @modelcontextprotocol/sdk: MCP server/client + transports.
- better-sqlite3: synchronous SQLite, fast, local.
- zod: schema validation for config and tool inputs.
- dotenv: env loading.
- express: HTTP routing (transitive via SDK).
- Dev: typescript, tsx, vitest, biome, @types/*.

## Consolidation (phase 2, stub)

Providers: none (default), anthropic (Haiku-class), ollama. Monthly token budget cap. Pipeline: summarize unconsolidated events into session summaries, extract durable facts, merge near-duplicates, supersede contradicted facts, decay/archive stale items. Not implemented in v1; `make consolidate` prints notice.
