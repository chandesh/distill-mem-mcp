import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextMarkdown } from '../src/core/retrieve.js';
import { estimateTokens } from '../src/core/tokens.js';
import { closeDb, getDb, openDb } from '../src/db/index.js';

describe('context budget', () => {
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

  it('never exceeds budget', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO entities (name, entity_type, project, created_at, updated_at, pinned, importance) VALUES (?,?,?,?,?,?,?)`,
    ).run('PinnedFact', 'fact', 'proj', now, now, 1, 1);
    const eid = (
      db.prepare('SELECT id FROM entities WHERE name=?').get('PinnedFact') as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO observations (entity_id, content, source, created_at, importance, content_hash) VALUES (?,?,?,?,?,?)`,
    ).run(eid, 'important pinned fact content here', 'manual', now, 1, 'h1');
    for (let i = 0; i < 50; i++) {
      db.prepare(
        `INSERT INTO entities (name, entity_type, project, created_at, updated_at, importance) VALUES (?,?,?,?,?,?)`,
      ).run(`Ent${i}`, 'note', 'proj', now, now, 0.5);
    }
    const budget = 300;
    const { markdown, tokens } = buildContextMarkdown(db, 'proj', budget);
    expect(tokens).toBeLessThanOrEqual(budget);
    expect(estimateTokens(markdown)).toBeLessThanOrEqual(budget + 5); // estimator tolerance
  });
});
