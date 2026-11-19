import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import express from 'express';
import { getConfig } from '../config.js';
import { cleanHookPayload, deriveProject } from '../core/capture.js';
import { buildContextMarkdown, logTokenLedger } from '../core/retrieve.js';

export function createRouter(db: Database.Database, dbPath: string): express.Router {
  const router = express.Router();
  const config = getConfig();

  function authMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void {
    const key = config.DISTILL_API_KEY;
    if (!key || req.path === '/health') {
      next();
      return;
    }
    const provided =
      req.header('x-api-key') ?? req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (provided !== key) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  }

  router.use(authMiddleware);

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0', db: dbPath });
  });

  router.post('/ingest', (req, res) => {
    const start = Date.now();
    try {
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const cleaned = cleanHookPayload(raw, config.DISTILL_INGEST_OUTPUT_CAP);
      if (!cleaned) {
        res.json({ accepted: false, dropped: true, ms: Date.now() - start });
        return;
      }
      const project = deriveProject(typeof raw.cwd === 'string' ? raw.cwd : undefined);
      const sessionId = typeof raw.session_id === 'string' ? raw.session_id : null;
      // Dedupe by hash + project + kind within recent events.
      const dup = db
        .prepare(`SELECT id FROM events WHERE project = ? AND kind = ? AND payload LIKE ? LIMIT 1`)
        .get(project, cleaned.kind, `%${cleaned.hash.slice(0, 16)}%`) as { id: number } | undefined;
      if (dup) {
        res.json({ accepted: false, duplicate: true, id: dup.id, ms: Date.now() - start });
        return;
      }
      const info = db
        .prepare(
          `INSERT INTO events (project, session_id, kind, payload, consolidated) VALUES (?, ?, ?, ?, 0)`,
        )
        .run(
          project,
          sessionId,
          cleaned.kind,
          JSON.stringify({ ...cleaned.payload, _hash: cleaned.hash }),
        );
      // Retention: trim oldest beyond cap.
      db.prepare(
        `DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)`,
      ).run(config.DISTILL_EVENT_RETENTION);
      res.json({ accepted: true, id: Number(info.lastInsertRowid), ms: Date.now() - start });
    } catch (err) {
      res.status(500).json({ error: String(err), ms: Date.now() - start });
    }
  });

  router.get('/context', (req, res) => {
    const project = String(req.query.project ?? 'default');
    const budget = Number(req.query.budget ?? config.DISTILL_DEFAULT_BUDGET);
    const safeBudget = Number.isFinite(budget)
      ? Math.min(Math.max(100, budget), 100000)
      : config.DISTILL_DEFAULT_BUDGET;
    const { markdown, tokens } = buildContextMarkdown(db, project, safeBudget);
    logTokenLedger(db, {
      project,
      kind: 'injection',
      tokensIn: tokens,
      tokensOut: tokens,
      note: 'session-start context',
    });
    res.type('text/markdown').send(markdown);
  });

  router.get('/stats', (req, res) => {
    const project = req.query.project ? String(req.query.project) : undefined;
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
    res.json({
      entities: entityCount,
      observations: obsCount,
      relations: relCount,
      events: eventCount,
      dbSizeBytes: dbSize,
      ledger,
    });
  });

  return router;
}
