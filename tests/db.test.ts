import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from '../src/db/index.js';

describe('db + remember dedupe', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'distill-'));
    dbPath = join(dir, 'test.db');
    openDb({ path: dbPath });
  });
  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates entity and dedupes observations', async () => {
    const { registerTools } = await import('../src/mcp/tools.js');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const server = new McpServer({ name: 't', version: '0.1' });
    const { getDb } = await import('../src/db/index.js');
    const db = getDb();
    registerTools(server, db, dbPath);

    // call tool handler directly via server? Instead replicate via db operations minimal:
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities (name, entity_type, project, created_at, updated_at, importance, pinned) VALUES (?,?,?,?,?,?,?)`,
    ).run('Foo', 'concept', 'proj', now, now, 0.5, 0);
    const id = (db.prepare('SELECT id FROM entities WHERE name=?').get('Foo') as { id: number }).id;
    const hash = (await import('node:crypto')).createHash('sha256').update('hello').digest('hex');
    db.prepare(
      `INSERT INTO observations (entity_id, content, source, created_at, importance, content_hash) VALUES (?,?,?,?,?,?)`,
    ).run(id, 'hello', 'manual', now, 0.5, hash);
    // duplicate insert should fail unique
    let threw = false;
    try {
      db.prepare(
        `INSERT INTO observations (entity_id, content, source, created_at, importance, content_hash) VALUES (?,?,?,?,?,?)`,
      ).run(id, 'hello', 'manual', now, 0.5, hash);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('supersede excludes from default get', async () => {
    const now = new Date().toISOString();
    const { getDb } = await import('../src/db/index.js');
    const db = getDb();
    db.prepare(
      `INSERT INTO entities (name, entity_type, project, created_at, updated_at) VALUES (?,?,?,?,?)`,
    ).run('Bar', 'concept', 'proj', now, now);
    const eid = (db.prepare('SELECT id FROM entities WHERE name=?').get('Bar') as { id: number })
      .id;
    const h1 = (await import('node:crypto')).createHash('sha256').update('old').digest('hex');
    const h2 = (await import('node:crypto')).createHash('sha256').update('new').digest('hex');
    const r1 = db
      .prepare(
        `INSERT INTO observations (entity_id, content, source, created_at, importance, content_hash) VALUES (?,?,?,?,?,?)`,
      )
      .run(eid, 'old', 'manual', now, 0.5, h1);
    const r2 = db
      .prepare(
        `INSERT INTO observations (entity_id, content, source, created_at, importance, content_hash) VALUES (?,?,?,?,?,?)`,
      )
      .run(eid, 'new', 'manual', now, 0.5, h2);
    db.prepare('UPDATE observations SET superseded_by = ? WHERE id = ?').run(
      Number(r2.lastInsertRowid),
      Number(r1.lastInsertRowid),
    );
    const { getEntityDetails } = await import('../src/core/retrieve.js');
    const details = getEntityDetails(db, { names: ['Bar'], project: 'proj' });
    expect(details[0].observations.map((o) => o.content)).toEqual(['new']);
  });
});
