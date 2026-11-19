import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = 1;

export interface DbOptions {
  path: string;
  readonly?: boolean;
}

let current: Database.Database | undefined;

export function openDb(options: DbOptions): Database.Database {
  const db = new Database(options.path, { readonly: options.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // Run migrations
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');
  db.exec(sql);
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }
  current = db;
  return db;
}

export function getDb(): Database.Database {
  if (!current) {
    throw new Error('Database not opened. Call openDb() first.');
  }
  return current;
}

export function closeDb(): void {
  if (current) {
    current.close();
    current = undefined;
  }
}

export function dbPathFromConfig(): string {
  return process.env.DISTILL_DB_PATH ?? '/data/distill.db';
}
