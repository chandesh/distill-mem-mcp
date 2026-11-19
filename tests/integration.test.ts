import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { closeDb, openDb } from '../src/db/index.js';
import { createRouter } from '../src/http/routes.js';
import { registerTools } from '../src/mcp/tools.js';

describe('integration', () => {
  let dir: string;
  let dbPath: string;
  let server: ReturnType<express.Express['listen']>;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'distill-'));
    dbPath = join(dir, 'test.db');
    loadConfig({ DISTILL_DB_PATH: dbPath, DISTILL_PORT: 18787 } as never);
    openDb({ path: dbPath });
    const db = (await import('../src/db/index.js')).getDb();
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.post('/mcp', async (req, res) => {
      const s = new McpServer({ name: 'distill-mem-mcp', version: '0.1.0' });
      registerTools(s, db, dbPath);
      const t = new StreamableHTTPServerTransport({});
      await s.connect(t);
      try {
        await t.handleRequest(req, res, req.body);
      } finally {
        await t.close().catch(() => undefined);
        await s.close().catch(() => undefined);
      }
    });
    app.use(createRouter(db, dbPath));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 8787;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('health', async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.status).toBe('ok');
  });

  it('ingest and context', async () => {
    const r = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        tool_response: 'hi',
        cwd: '/tmp/myproj',
      }),
    });
    const j = await r.json();
    expect(j.accepted).toBe(true);
    const c = await fetch(`${baseUrl}/context?project=myproj&budget=500`);
    const text = await c.text();
    expect(text).toContain('myproj');
  });

  it('mcp remember/search/get', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);
    const rem = await client.callTool({
      name: 'remember',
      arguments: { project: 'p', name: 'Foo', type: 'concept', observations: ['bar fact'] },
    });
    expect(JSON.stringify(rem)).toContain('Foo');
    const srch = await client.callTool({
      name: 'search',
      arguments: { project: 'p', query: 'Foo', limit: 5 },
    });
    expect(JSON.stringify(srch)).toContain('Foo');
    const got = await client.callTool({ name: 'get', arguments: { project: 'p', names: ['Foo'] } });
    expect(JSON.stringify(got)).toContain('bar fact');
    await client.close();
  });
});
