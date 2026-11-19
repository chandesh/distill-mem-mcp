import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { type EntityRef, resolveEntity } from '../core/resolve.js';
import { getEntityDetails, search } from '../core/retrieve.js';
import { logged } from './log.js';

const OBSERVATION_REF_ERROR = 'observation refs must be numeric ids; call get to find the id';

function errorResult(error: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    isError: true,
  };
}

export function registerTools(server: McpServer, db: Database.Database, dbPath: string): void {
  const config = getConfig();

  server.registerTool(
    'remember',
    {
      description:
        'Create or update an entity and add atomic observations. Dedupes observations by content hash.',
      inputSchema: z.object({
        project: z.string().min(1),
        name: z.union([z.string().min(1), z.number().int()]),
        type: z.string().min(1),
        observations: z.array(z.string().min(1)).default([]),
        importance: z.number().min(0).max(1).optional(),
        pinned: z.boolean().optional(),
      }),
    },
    logged('remember', async (input) => {
      const now = new Date().toISOString();
      const importance = input.importance ?? 0.5;
      let entityId: number;
      let entityName: string;

      if (typeof input.name === 'number') {
        const resolved = resolveEntity(db, input.project, input.name);
        if (!resolved.ok) return errorResult(resolved.error);
        const row = db
          .prepare(
            `UPDATE entities SET entity_type = ?, importance = ?, pinned = COALESCE(?, pinned),
             updated_at = ? WHERE id = ? RETURNING id, name`,
          )
          .get(
            input.type,
            importance,
            input.pinned === undefined ? null : input.pinned ? 1 : 0,
            now,
            resolved.id,
          ) as { id: number; name: string } | undefined;
        if (!row) return errorResult(`entity ${input.name} not found in project ${input.project}`);
        entityId = row.id;
        entityName = row.name;
      } else {
        const existing = db
          .prepare('SELECT id FROM entities WHERE name = ? AND project = ?')
          .get(input.name, input.project) as { id: number } | undefined;
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
        entityName = input.name;
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

      const observationIds = (
        db
          .prepare('SELECT id FROM observations WHERE entity_id = ? ORDER BY id ASC')
          .all(entityId) as Array<{
          id: number;
        }>
      ).map((row) => row.id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: entityId,
              name: entityName,
              added,
              skipped,
              observationIds,
            }),
          },
        ],
      };
    }),
  );

  server.registerTool(
    'relate',
    {
      description: 'Relate two entities by id or name.',
      inputSchema: z.object({
        project: z.string().min(1),
        from: z.union([z.string().min(1), z.number().int()]),
        to: z.union([z.string().min(1), z.number().int()]),
        relation_type: z.string().min(1),
      }),
    },
    logged('relate', async (input) => {
      const fromRow = resolveEntity(db, input.project, input.from as EntityRef);
      if (!fromRow.ok) return errorResult(fromRow.error);
      const toRow = resolveEntity(db, input.project, input.to as EntityRef);
      if (!toRow.ok) return errorResult(toRow.error);
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
    }),
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
    logged('search', async (input) => {
      const hits = search(db, { query: input.query, project: input.project, limit: input.limit });
      return {
        content: [{ type: 'text', text: JSON.stringify({ results: hits, count: hits.length }) }],
      };
    }),
  );

  server.registerTool(
    'get',
    {
      description:
        'Fetch entities by id or name (ids/names interchangeable); includes observations.',
      inputSchema: z.object({
        project: z.string().min(1),
        ids: z.array(z.union([z.string().min(1), z.number().int()])).optional(),
        names: z.array(z.union([z.string().min(1), z.number().int()])).optional(),
        includeSuperseded: z.boolean().default(false),
      }),
    },
    logged('get', async (input) => {
      const refs = [...(input.ids ?? []), ...(input.names ?? [])] as EntityRef[];
      const ids: number[] = [];
      for (const ref of refs) {
        const resolved = resolveEntity(db, input.project, ref);
        if (!resolved.ok) return errorResult(resolved.error);
        if (!ids.includes(resolved.id)) ids.push(resolved.id);
      }
      const details = getEntityDetails(db, {
        project: input.project,
        includeSuperseded: input.includeSuperseded,
        ...(ids.length ? { ids } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ entities: details }) }] };
    }),
  );

  server.registerTool(
    'supersede',
    {
      description: 'Mark an observation as replaced by a newer one. Observation ids only.',
      inputSchema: z.object({
        oldObservationId: z.union([z.number().int(), z.string()]),
        newObservationId: z.union([z.number().int(), z.string()]),
      }),
    },
    logged('supersede', async (input) => {
      if (
        typeof input.oldObservationId !== 'number' ||
        typeof input.newObservationId !== 'number'
      ) {
        return errorResult(OBSERVATION_REF_ERROR);
      }
      const res = db
        .prepare('UPDATE observations SET superseded_by = ? WHERE id = ?')
        .run(input.newObservationId, input.oldObservationId);
      return { content: [{ type: 'text', text: JSON.stringify({ updated: res.changes > 0 }) }] };
    }),
  );

  server.registerTool(
    'forget',
    {
      description: 'Archive (default) or hard-delete entities or observations.',
      inputSchema: z.object({
        project: z.string().min(1),
        entityIds: z.array(z.union([z.string().min(1), z.number().int()])).optional(),
        observationIds: z.array(z.union([z.number().int(), z.string()])).optional(),
        hard: z.boolean().default(false),
      }),
    },
    logged('forget', async (input) => {
      const entityIds: number[] = [];
      for (const ref of (input.entityIds ?? []) as EntityRef[]) {
        const resolved = resolveEntity(db, input.project, ref);
        if (!resolved.ok) return errorResult(resolved.error);
        if (!entityIds.includes(resolved.id)) entityIds.push(resolved.id);
      }
      const observationIds: number[] = [];
      for (const ref of input.observationIds ?? []) {
        if (typeof ref !== 'number') return errorResult(OBSERVATION_REF_ERROR);
        observationIds.push(ref);
      }

      let changed = 0;
      if (entityIds.length) {
        if (input.hard) {
          const stmt = db.prepare('DELETE FROM entities WHERE id = ? AND project = ?');
          for (const id of entityIds) changed += stmt.run(id, input.project).changes;
        } else {
          const stmt = db.prepare(
            'UPDATE entities SET archived = 1, updated_at = ? WHERE id = ? AND project = ?',
          );
          const now = new Date().toISOString();
          for (const id of entityIds) changed += stmt.run(now, id, input.project).changes;
        }
      }
      if (observationIds.length) {
        if (input.hard) {
          const stmt = db.prepare('DELETE FROM observations WHERE id = ?');
          for (const id of observationIds) changed += stmt.run(id).changes;
        } else {
          // observations have no archived flag; supersede self by null? Use ttl_at past.
          const stmt = db.prepare("UPDATE observations SET ttl_at = datetime('now') WHERE id = ?");
          for (const id of observationIds) changed += stmt.run(id).changes;
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ changed }) }] };
    }),
  );

  server.registerTool(
    'stats',
    {
      description: 'Counts, DB size, and recent token ledger totals.',
      inputSchema: z.object({
        project: z.string().optional(),
      }),
    },
    logged('stats', async (input) => {
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
      const savedRow = db
        .prepare(`SELECT COALESCE(SUM(tokens_in - tokens_out), 0) AS s FROM token_ledger ${scope}`)
        .get(...args) as { s: number };
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
              tokensSaved: savedRow.s,
            }),
          },
        ],
      };
    }),
  );

  // Touch config to avoid unused
  void config;
}
