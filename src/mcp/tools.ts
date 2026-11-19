import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { getEntityDetails, search } from '../core/retrieve.js';

export function registerTools(server: McpServer, db: Database.Database, dbPath: string): void {
  const config = getConfig();

  server.registerTool(
    'remember',
    {
      description:
        'Create or update an entity and add atomic observations. Dedupes observations by content hash.',
      inputSchema: z.object({
        project: z.string().min(1),
        name: z.string().min(1),
        type: z.string().min(1),
        observations: z.array(z.string().min(1)).default([]),
        importance: z.number().min(0).max(1).optional(),
        pinned: z.boolean().optional(),
      }),
    },
    async (input) => {
      const now = new Date().toISOString();
      const importance = input.importance ?? 0.5;
      // Upsert entity
      const existing = db
        .prepare('SELECT id FROM entities WHERE name = ? AND project = ?')
        .get(input.name, input.project) as { id: number } | undefined;
      let entityId: number;
      if (existing) {
        db.prepare(
          `UPDATE entities SET entity_type = ?, importance = ?, pinned = COALESCE(?, pinned),
            updated_at = ? WHERE id = ?`,
        ).run(
          input.type,
          importance,
          input.pinned === undefined ? null : input.pinned ? 1 : 0,
          now,
          existing.id,
        );
        entityId = existing.id;
      } else {
        const res = db
          .prepare(
            `INSERT INTO entities (name, entity_type, project, created_at, updated_at, importance, pinned)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(input.name, input.type, input.project, now, now, importance, input.pinned ? 1 : 0);
        entityId = Number(res.lastInsertRowid);
      }

      let added = 0;
      let skipped = 0;
      const insertObs = db.prepare(
        `INSERT OR IGNORE INTO observations (entity_id, content, source, created_at, importance, content_hash)
         VALUES (?, ?, 'manual', ?, ?, ?)`,
      );
      for (const content of input.observations) {
        const hash = createHash('sha256').update(content.trim()).digest('hex');
        const r = insertObs.run(entityId, content.trim(), now, importance, hash);
        if (r.changes > 0) added += 1;
        else skipped += 1;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id: entityId, name: input.name, added, skipped }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'relate',
    {
      description: 'Create a directed, active-voice relation between two entities.',
      inputSchema: z.object({
        project: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        relation_type: z.string().min(1),
      }),
    },
    async (input) => {
      const fromRow = db
        .prepare('SELECT id FROM entities WHERE name = ? AND project = ?')
        .get(input.from, input.project) as { id: number } | undefined;
      const toRow = db
        .prepare('SELECT id FROM entities WHERE name = ? AND project = ?')
        .get(input.to, input.project) as { id: number } | undefined;
      if (!fromRow || !toRow) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'entity not found' }) }],
          isError: true,
        };
      }
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)`,
        )
        .run(fromRow.id, toRow.id, input.relation_type);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id: res.lastInsertRowid || null, created: res.changes > 0 }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'search',
    {
      description:
        'FTS5 search returning a compact index only: id, name, type, snippet, score. No full observations.',
      inputSchema: z.object({
        query: z.string().min(1),
        project: z.string().min(1),
        limit: z.number().int().min(1).max(25).default(8),
      }),
    },
    async (input) => {
      const hits = search(db, { query: input.query, project: input.project, limit: input.limit });
      return {
        content: [{ type: 'text', text: JSON.stringify({ results: hits, count: hits.length }) }],
      };
    },
  );

  server.registerTool(
    'get',
    {
      description:
        'Fetch full details for entity ids or names, including non-superseded observations and relations.',
      inputSchema: z.object({
        project: z.string().min(1),
        ids: z.array(z.number().int()).optional(),
        names: z.array(z.string()).optional(),
        includeSuperseded: z.boolean().default(false),
      }),
    },
    async (input) => {
      const details = getEntityDetails(db, {
        project: input.project,
        includeSuperseded: input.includeSuperseded,
        ...(input.ids ? { ids: input.ids } : {}),
        ...(input.names ? { names: input.names } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ entities: details }) }] };
    },
  );

  server.registerTool(
    'supersede',
    {
      description:
        'Mark an observation as replaced by a newer one. Old kept for history, excluded by default.',
      inputSchema: z.object({
        oldObservationId: z.number().int(),
        newObservationId: z.number().int(),
      }),
    },
    async (input) => {
      const res = db
        .prepare('UPDATE observations SET superseded_by = ? WHERE id = ?')
        .run(input.newObservationId, input.oldObservationId);
      return { content: [{ type: 'text', text: JSON.stringify({ updated: res.changes > 0 }) }] };
    },
  );

  server.registerTool(
    'forget',
    {
      description: 'Archive (default) or hard-delete entities or observations.',
      inputSchema: z.object({
        project: z.string().min(1),
        entityIds: z.array(z.number().int()).optional(),
        observationIds: z.array(z.number().int()).optional(),
        hard: z.boolean().default(false),
      }),
    },
    async (input) => {
      let changed = 0;
      if (input.entityIds?.length) {
        if (input.hard) {
          const stmt = db.prepare('DELETE FROM entities WHERE id = ? AND project = ?');
          for (const id of input.entityIds) changed += stmt.run(id, input.project).changes;
        } else {
          const stmt = db.prepare(
            'UPDATE entities SET archived = 1, updated_at = ? WHERE id = ? AND project = ?',
          );
          const now = new Date().toISOString();
          for (const id of input.entityIds) changed += stmt.run(now, id, input.project).changes;
        }
      }
      if (input.observationIds?.length) {
        if (input.hard) {
          const stmt = db.prepare('DELETE FROM observations WHERE id = ?');
          for (const id of input.observationIds) changed += stmt.run(id).changes;
        } else {
          // observations have no archived flag; supersede self by null? Use ttl_at past.
          const stmt = db.prepare("UPDATE observations SET ttl_at = datetime('now') WHERE id = ?");
          for (const id of input.observationIds) changed += stmt.run(id).changes;
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ changed }) }] };
    },
  );

  server.registerTool(
    'stats',
    {
      description: 'Counts, DB size, and recent token ledger totals.',
      inputSchema: z.object({
        project: z.string().optional(),
      }),
    },
    async (input) => {
      const project = input.project;
      const scope = project ? 'WHERE project = ?' : '';
      const args = project ? [project] : [];
      const entityCount = (
        db.prepare(`SELECT COUNT(*) AS c FROM entities ${scope}`).get(...args) as { c: number }
      ).c;
      const obsCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM observations o JOIN entities e ON e.id=o.entity_id ${project ? 'WHERE e.project = ?' : ''}`,
          )
          .get(...args) as { c: number }
      ).c;
      const relCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM relations r JOIN entities e ON e.id=r.from_entity_id ${project ? 'WHERE e.project = ?' : ''}`,
          )
          .get(...args) as { c: number }
      ).c;
      const eventCount = (
        db.prepare(`SELECT COUNT(*) AS c FROM events ${scope}`).get(...args) as { c: number }
      ).c;
      let dbSize = 0;
      try {
        dbSize = statSync(dbPath).size;
      } catch {
        dbSize = 0;
      }
      const ledger = db
        .prepare(
          `SELECT kind, SUM(tokens_in) AS ti, SUM(tokens_out) AS toks FROM token_ledger ${scope} GROUP BY kind`,
        )
        .all(...args) as Array<{ kind: string; ti: number; toks: number }>;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              entities: entityCount,
              observations: obsCount,
              relations: relCount,
              events: eventCount,
              dbSizeBytes: dbSize,
              ledger,
            }),
          },
        ],
      };
    },
  );

  // Touch config to avoid unused
  void config;
}
