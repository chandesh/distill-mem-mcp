# Architecture

## Overview

```mermaid
flowchart LR
  A[Agentic Tool] -- MCP /mcp --> S[distill-mem-mcp]
  A -- hooks --> H[capture.sh / session-start.sh]
  H -- HTTP --> S
  S --> DB[(SQLite WAL\n./data/distill.db)]
  S --> L[Token ledger]
```

## Request flow

```mermaid
sequenceDiagram
  participant AT as Agentic Tool
  participant S as distill-mem-mcp
  participant DB as SQLite
  AT->>S: POST /ingest (hook payload)
  S->>S: rule-based clean + dedupe
  S->>DB: insert event
  AT->>S: GET /context?project&budget
  S->>DB: pinned + ranked index + summary
  S->>S: enforce token budget
  S-->>AT: markdown context
  AT->>S: MCP tools (remember/search/get)
  S->>DB: read/write
```

## Components

- **Entrypoint** `src/server.ts`: transport selection (http/stdio).
- **MCP tools** `src/mcp/tools.ts`: remember, relate, search, get, supersede, forget, stats.
- **REST** `src/http/routes.ts`: health, ingest, context, stats.
- **DB** `src/db`: schema, migrations, FTS5.
- **Core** `src/core`: capture, retrieve, tokens, decay, consolidate (stub).

## Data flow for memory injection

1. Hooks capture events -> `/ingest` (clean, dedupe, store).
2. Session start -> `/context` builds markdown from pinned facts, ranked entity index, latest summary.
3. Budget enforced by token estimator; truncation by rank.
4. Ledger logs injection tokens.

## Supported agentic tools

Claude Code, OpenCode, and other MCP-compatible clients.