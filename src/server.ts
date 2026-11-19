#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type Database from 'better-sqlite3';
import express from 'express';
import { getConfig, loadConfig } from './config.js';
import { closeDb, openDb } from './db/index.js';
import { createRouter } from './http/routes.js';
import { registerTools } from './mcp/tools.js';

function parseArgs(argv: string[]): { transport?: 'http' | 'stdio' } {
  const out: { transport?: 'http' | 'stdio' } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--transport') {
      const v = argv[i + 1];
      if (v === 'http' || v === 'stdio') out.transport = v;
      i += 1;
    }
  }
  return out;
}

async function handleMcp(
  req: express.Request,
  res: express.Response,
  db: Database.Database,
  dbPath: string,
  body?: unknown,
): Promise<void> {
  const server = new McpServer({ name: 'distill-mem-mcp', version: '0.1.0' });
  registerTools(server, db, dbPath);
  const transport = new StreamableHTTPServerTransport({});
  await server.connect(transport);
  try {
    await transport.handleRequest(req, res, body);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const transportMode = args.transport ?? config.DISTILL_TRANSPORT;

  const db = openDb({ path: config.DISTILL_DB_PATH });

  if (transportMode === 'stdio') {
    const server = new McpServer({ name: 'distill-mem-mcp', version: '0.1.0' });
    registerTools(server, db, config.DISTILL_DB_PATH);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.on('SIGINT', () => {
      void server
        .close()
        .then(() => closeDb())
        .then(() => process.exit(0));
    });
    return;
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.post('/mcp', async (req, res) => {
    await handleMcp(req, res, db, config.DISTILL_DB_PATH, req.body);
  });
  app.get('/mcp', async (req, res) => {
    await handleMcp(req, res, db, config.DISTILL_DB_PATH);
  });
  app.delete('/mcp', async (req, res) => {
    await handleMcp(req, res, db, config.DISTILL_DB_PATH);
  });

  app.use(createRouter(db, config.DISTILL_DB_PATH));

  const httpServer = app.listen(config.DISTILL_PORT, config.DISTILL_HOST, () => {
    process.stderr.write(
      `distill-mem-mcp listening on ${config.DISTILL_HOST}:${config.DISTILL_PORT}\n`,
    );
  });

  const shutdown = (): void => {
    httpServer.close(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
