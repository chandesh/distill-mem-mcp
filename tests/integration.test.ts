import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { closeDb, openDb } from '../src/db/index.js';
import { createRouter } from '../src/http/routes.js';
import { installRpcErrorLogging } from '../src/mcp/log.js';
import { registerTools } from '../src/mcp/tools.js';

describe('integration', () => {
  let dir: string;
  let dbPath: string;
  let server: ReturnType<express.Express['listen']>;
  let port: number;
  let baseUrl: string;

  async function connectClient(): Promise<Client> {
    const client = new Client({ name: 'test-refs', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);
    return client;
  }

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
      installRpcErrorLogging(t, req.body);
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

  it('logs a tool call to stderr with request and response token counts', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const client = new Client({ name: 'test-log', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);
      await client.callTool({
        name: 'search',
        arguments: { project: 'p', query: 'Foo', limit: 5 },
      });
      await client.close();

      const out = write.mock.calls.map((call) => String(call[0])).join('');
      expect(out).toMatch(/\[mcp\] .* search in=\d+ out=\d+ ok req=.* res=/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('relates entities by numeric ids', async () => {
    const client = await connectClient();
    try {
      const a = rememberData(
        await client.callTool({
          name: 'remember',
          arguments: { project: 'ids', name: 'A', type: 'concept', observations: ['a fact'] },
        }),
      );
      const b = rememberData(
        await client.callTool({
          name: 'remember',
          arguments: { project: 'ids', name: 'B', type: 'concept', observations: ['b fact'] },
        }),
      );
      const rel = await client.callTool({
        name: 'relate',
        arguments: { project: 'ids', from: a.id, to: b.id, relation_type: 'part_of' },
      });
      expect(toolData(rel).created).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('relates entities by names', async () => {
    const client = await connectClient();
    try {
      await client.callTool({
        name: 'remember',
        arguments: { project: 'names', name: 'A', type: 'concept', observations: [] },
      });
      await client.callTool({
        name: 'remember',
        arguments: { project: 'names', name: 'B', type: 'concept', observations: [] },
      });
      const rel = await client.callTool({
        name: 'relate',
        arguments: { project: 'names', from: 'A', to: 'B', relation_type: 'part_of' },
      });
      expect(toolData(rel).created).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('relates entities by mixed id and name', async () => {
    const client = await connectClient();
    try {
      const a = rememberData(
        await client.callTool({
          name: 'remember',
          arguments: { project: 'mixed', name: 'A', type: 'concept', observations: [] },
        }),
      );
      await client.callTool({
        name: 'remember',
        arguments: { project: 'mixed', name: 'B', type: 'concept', observations: [] },
      });
      const rel = await client.callTool({
        name: 'relate',
        arguments: { project: 'mixed', from: a.id, to: 'B', relation_type: 'part_of' },
      });
      expect(toolData(rel).created).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('reports an actionable error for a missing entity id', async () => {
    const client = await connectClient();
    try {
      const rel = await client.callTool({
        name: 'relate',
        arguments: { project: 'missing', from: 999, to: 'B', relation_type: 'part_of' },
      });
      expect(isErrorResult(rel)).toBe(true);
      expect(toolData(rel).error).toBe('entity 999 not found in project missing');
    } finally {
      await client.close();
    }
  });

  it('returns observation ids from remember and get', async () => {
    const client = await connectClient();
    try {
      const rem = rememberData(
        await client.callTool({
          name: 'remember',
          arguments: {
            project: 'obsids',
            name: 'A',
            type: 'concept',
            observations: ['a fact'],
          },
        }),
      );
      const observationIds = rem.observationIds as number[];
      expect(observationIds.length).toBeGreaterThan(0);
      expect(observationIds[0]).toBeGreaterThan(0);

      const got = toolData(
        await client.callTool({
          name: 'get',
          arguments: { project: 'obsids', names: ['A'] },
        }),
      );
      const entities = got.entities as Array<{ observations: Array<{ id: number }> }>;
      expect(entities[0].observations[0].id).toBe(observationIds[0]);
    } finally {
      await client.close();
    }
  });

  it('merges get ids and names into one de-duplicated list', async () => {
    const client = await connectClient();
    try {
      const a = rememberData(
        await client.callTool({
          name: 'remember',
          arguments: { project: 'merge', name: 'A', type: 'concept', observations: [] },
        }),
      );
      const got = toolData(
        await client.callTool({
          name: 'get',
          arguments: { project: 'merge', ids: [a.id], names: ['A'] },
        }),
      );
      expect((got.entities as unknown[]).length).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('rejects string observation refs with an actionable error', async () => {
    const client = await connectClient();
    try {
      const sup = await client.callTool({
        name: 'supersede',
        arguments: { oldObservationId: '1', newObservationId: 2 },
      });
      expect(toolData(sup).error).toBe(
        'observation refs must be numeric ids; call get to find the id',
      );
    } finally {
      await client.close();
    }
  });

  it('logs JSON-RPC validation failures with arg keys/types only', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const client = await connectClient();
      const result = await client.callTool({
        name: 'relate',
        arguments: { project: 'secret-project', from: 7, to: 4, type: 'part_of' },
      });
      await client.close();

      const text = JSON.stringify(result);
      expect(text).toMatch(/Invalid arguments|validation error|-32602/i);

      const out = write.mock.calls.map((call) => String(call[0])).join('');
      expect(out).toMatch(/rpc_error code=-32602/);
      expect(out).toContain('tool=relate');
      expect(out).toContain('from:number');
      expect(out).toContain('to:number');
      expect(out).toContain('type:string');
      expect(out).not.toContain('secret-project');
      expect(out).not.toContain('part_of');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

function toolData(result: unknown): Record<string, unknown> {
  const toolResult = result as { content: Array<{ text: string }> };
  return JSON.parse(toolResult.content[0].text) as Record<string, unknown>;
}

function rememberData(result: unknown): { id: number; name: string; observationIds: number[] } {
  const data = toolData(result);
  return {
    id: data.id as number,
    name: data.name as string,
    observationIds: data.observationIds as number[],
  };
}

function isErrorResult(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}
