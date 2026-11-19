import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEntity } from '../src/core/resolve.js';
import { closeDb, getDb, openDb } from '../src/db/index.js';

describe('resolveEntity', () => {
  let dir: string;
  let db: Database.Database;
  let fooId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'distill-resolve-'));
    openDb({ path: join(dir, 'test.db') });
    db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO entities (name, entity_type, project, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('Foo', 'concept', 'p', now, now);
    fooId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('Foo') as { id: number }).id;
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a number as an entity id', () => {
    expect(resolveEntity(db, 'p', fooId)).toEqual({ ok: true, id: fooId });
  });

  it('resolves a string as an exact entity name', () => {
    expect(resolveEntity(db, 'p', 'Foo')).toEqual({ ok: true, id: fooId });
  });

  it('reports a missing id with project scope', () => {
    expect(resolveEntity(db, 'p', 99)).toEqual({
      ok: false,
      error: 'entity 99 not found in project p',
    });
  });

  it('reports a missing name with project scope', () => {
    expect(resolveEntity(db, 'p', 'Missing')).toEqual({
      ok: false,
      error: "entity 'Missing' not found in project p",
    });
  });

  it('reports candidate ids when a name resolves to multiple rows', () => {
    const duplicateDb = {
      prepare: () => ({ all: () => [{ id: 1 }, { id: 2 }] }),
    } as unknown as Database.Database;

    expect(resolveEntity(duplicateDb, 'p', 'Foo')).toEqual({
      ok: false,
      error: "entity 'Foo' is ambiguous in project p; candidate ids: 1, 2",
    });
  });
});
