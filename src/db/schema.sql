-- distill-mem-mcp schema v1
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  project TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0.5,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (name, project)
);

CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project);
CREATE INDEX IF NOT EXISTS idx_entities_archived ON entities(archived);
CREATE INDEX IF NOT EXISTS idx_entities_pinned ON entities(pinned);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  importance REAL NOT NULL DEFAULT 0.5,
  superseded_by INTEGER REFERENCES observations(id),
  ttl_at TEXT,
  content_hash TEXT NOT NULL,
  UNIQUE (entity_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_obs_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at);
CREATE INDEX IF NOT EXISTS idx_obs_superseded ON observations(superseded_by);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_entity_id, to_entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_entity_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consolidated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_consolidated ON events(consolidated);

CREATE TABLE IF NOT EXISTS session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ss_project ON session_summaries(project);

CREATE TABLE IF NOT EXISTS token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_tl_project ON token_ledger(project);
CREATE INDEX IF NOT EXISTS idx_tl_ts ON token_ledger(ts);

-- FTS5 virtual tables
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, entity_type, project, content='entities', content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  content, content='observations', content_rowid='id'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, entity_type, project) VALUES (new.id, new.name, new.entity_type, new.project);
END;

CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, entity_type, project) VALUES ('delete', old.id, old.name, old.entity_type, old.project);
END;

CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, entity_type, project) VALUES ('delete', old.id, old.name, old.entity_type, old.project);
  INSERT INTO entities_fts(rowid, name, entity_type, project) VALUES (new.id, new.name, new.entity_type, new.project);
END;

CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;
