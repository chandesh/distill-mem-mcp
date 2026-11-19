import type Database from 'better-sqlite3';
import { decayFactor, recencyScore } from './decay.js';
import { estimateTokens } from './tokens.js';

export interface SearchHit {
  id: number;
  name: string;
  type: string;
  snippet: string;
  score: number;
}

export interface EntityDetail {
  id: number;
  name: string;
  type: string;
  project: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  importance: number;
  pinned: boolean;
  archived: boolean;
  observations: Array<{
    id: number;
    content: string;
    source: string;
    session_id: string | null;
    created_at: string;
    importance: number;
    superseded_by: number | null;
    ttl_at: string | null;
  }>;
  relations: Array<{
    id: number;
    from: number;
    to: number;
    type: string;
    other_name: string;
    direction: 'out' | 'in';
  }>;
}

function safeFtsQuery(q: string): string {
  const tokens = q
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}

function accessFreq(count: number): number {
  return Math.min(1, count / 20);
}

export function search(
  db: Database.Database,
  params: { query: string; project: string; limit: number },
): SearchHit[] {
  const fts = safeFtsQuery(params.query);
  if (!fts) return [];
  const limit = Math.min(Math.max(1, params.limit), 25);
  // FTS over entities scoped by project.
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.entity_type, e.project, e.created_at, e.updated_at,
              e.last_accessed_at, e.access_count, e.importance, e.pinned, e.archived,
              bm25(entities_fts) AS bm25,
              snippet(entities_fts, 0, '', '', '...', 10) AS snip
       FROM entities_fts
       JOIN entities e ON e.id = entities_fts.rowid
       WHERE entities_fts MATCH ? AND e.project = ? AND e.archived = 0
       LIMIT 100`,
    )
    .all(fts, params.project) as Array<Record<string, unknown>>;

  const now = new Date();
  const scored = rows.map((r) => {
    const bm25Raw = Number(r.bm25 ?? 0);
    const bm25Rel = 1 / (1 + Math.abs(bm25Raw));
    const rec = recencyScore(r.last_accessed_at as string | null, now);
    const imp = Number(r.importance ?? 0.5);
    const af = accessFreq(Number(r.access_count ?? 0));
    const df = decayFactor(
      {
        lastAccessedAt: r.last_accessed_at as string | null,
        createdAt: String(r.created_at),
        importance: imp,
        pinned: Boolean(r.pinned),
        archived: Boolean(r.archived),
      },
      now,
    );
    const pinnedBoost = r.pinned ? 0.25 : 0;
    const score = bm25Rel * 0.35 + rec * 0.2 + imp * 0.2 + af * 0.1 + df * 0.1 + pinnedBoost;
    const snippetRaw = String(r.snip ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const snippet = snippetRaw.length > 120 ? `${snippetRaw.slice(0, 117)}...` : snippetRaw;
    return {
      id: Number(r.id),
      name: String(r.name),
      type: String(r.entity_type),
      snippet: snippet || String(r.name),
      score: Math.round(score * 1000) / 1000,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function searchObservations(
  db: Database.Database,
  params: { query: string; project: string; limit: number },
): Array<{ id: number; entity_id: number; entity_name: string; snippet: string; score: number }> {
  const fts = safeFtsQuery(params.query);
  if (!fts) return [];
  const limit = Math.min(Math.max(1, params.limit), 25);
  const rows = db
    .prepare(
      `SELECT o.id, o.entity_id, o.content, o.created_at, o.importance, o.superseded_by,
              e.name AS entity_name, e.project, e.archived AS entity_archived,
              bm25(observations_fts) AS bm25
       FROM observations_fts
       JOIN observations o ON o.id = observations_fts.rowid
       JOIN entities e ON e.id = o.entity_id
       WHERE observations_fts MATCH ? AND e.project = ? AND e.archived = 0
         AND o.superseded_by IS NULL
       LIMIT 100`,
    )
    .all(fts, params.project) as Array<Record<string, unknown>>;

  const now = new Date();
  const scored = rows.map((r) => {
    const bm25Rel = 1 / (1 + Math.abs(Number(r.bm25 ?? 0)));
    const rec = recencyScore(String(r.created_at), now);
    const imp = Number(r.importance ?? 0.5);
    const score = bm25Rel * 0.5 + rec * 0.25 + imp * 0.25;
    const content = String(r.content);
    const snippet = content.length > 120 ? `${content.slice(0, 117)}...` : content;
    return {
      id: Number(r.id),
      entity_id: Number(r.entity_id),
      entity_name: String(r.entity_name),
      snippet,
      score: Math.round(score * 1000) / 1000,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function getEntityDetails(
  db: Database.Database,
  params: { ids?: number[]; names?: string[]; project: string; includeSuperseded?: boolean },
): EntityDetail[] {
  const conditions: string[] = ['project = ?'];
  const args: unknown[] = [params.project];
  if (params.ids?.length) {
    conditions.push(`id IN (${params.ids.map(() => '?').join(',')})`);
    args.push(...params.ids);
  } else if (params.names?.length) {
    conditions.push(`name IN (${params.names.map(() => '?').join(',')})`);
    args.push(...params.names);
  } else {
    return [];
  }
  const entities = db
    .prepare(`SELECT * FROM entities WHERE ${conditions.join(' AND ')}`)
    .all(...args) as Array<Record<string, unknown>>;

  const result: EntityDetail[] = [];
  for (const e of entities) {
    const obsWhere = params.includeSuperseded ? '' : 'AND superseded_by IS NULL';
    const observations = db
      .prepare(
        `SELECT id, content, source, session_id, created_at, importance, superseded_by, ttl_at
         FROM observations WHERE entity_id = ? ${obsWhere} ORDER BY created_at DESC`,
      )
      .all(Number(e.id)) as Array<Record<string, unknown>>;
    const relations = db
      .prepare(
        `SELECT r.id, r.from_entity_id, r.to_entity_id, r.relation_type,
                CASE WHEN r.from_entity_id = ? THEN te.name ELSE fe.name END AS other_name
         FROM relations r
         JOIN entities fe ON fe.id = r.from_entity_id
         JOIN entities te ON te.id = r.to_entity_id
         WHERE r.from_entity_id = ? OR r.to_entity_id = ?`,
      )
      .all(Number(e.id), Number(e.id), Number(e.id)) as Array<Record<string, unknown>>;

    result.push({
      id: Number(e.id),
      name: String(e.name),
      type: String(e.entity_type),
      project: String(e.project),
      created_at: String(e.created_at),
      updated_at: String(e.updated_at),
      last_accessed_at: (e.last_accessed_at as string | null) ?? null,
      access_count: Number(e.access_count),
      importance: Number(e.importance),
      pinned: Boolean(e.pinned),
      archived: Boolean(e.archived),
      observations: observations.map((o) => ({
        id: Number(o.id),
        content: String(o.content),
        source: String(o.source),
        session_id: (o.session_id as string | null) ?? null,
        created_at: String(o.created_at),
        importance: Number(o.importance),
        superseded_by: (o.superseded_by as number | null) ?? null,
        ttl_at: (o.ttl_at as string | null) ?? null,
      })),
      relations: relations.map((r) => ({
        id: Number(r.id),
        from: Number(r.from_entity_id),
        to: Number(r.to_entity_id),
        type: String(r.relation_type),
        other_name: String(r.other_name),
        direction: Number(r.from_entity_id) === Number(e.id) ? 'out' : 'in',
      })),
    });
  }

  // bump access stats
  const nowIso = new Date().toISOString();
  const bump = db.prepare(
    'UPDATE entities SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
  );
  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) bump.run(nowIso, id);
  });
  tx(result.map((r) => r.id));

  return result;
}

export function rankEntitiesForContext(
  db: Database.Database,
  project: string,
  limit: number,
): Array<{ id: number; name: string; type: string; line: string; score: number; tokens: number }> {
  const rows = db
    .prepare(
      `SELECT id, name, entity_type, importance, pinned, archived, access_count,
              created_at, last_accessed_at, updated_at
       FROM entities WHERE project = ? AND archived = 0`,
    )
    .all(project) as Array<Record<string, unknown>>;

  const now = new Date();
  const scored = rows.map((r) => {
    const imp = Number(r.importance ?? 0.5);
    const pinned = Boolean(r.pinned);
    const df = decayFactor(
      {
        lastAccessedAt: r.last_accessed_at as string | null,
        createdAt: String(r.created_at),
        importance: imp,
        pinned,
        archived: Boolean(r.archived),
      },
      now,
    );
    const af = accessFreq(Number(r.access_count ?? 0));
    const rec = recencyScore(r.last_accessed_at as string | null, now);
    const score = imp * 0.35 + df * 0.25 + af * 0.2 + rec * 0.1 + (pinned ? 0.1 : 0);
    // one-line index: name (type): top observation snippet
    const topObs = db
      .prepare(
        `SELECT content FROM observations WHERE entity_id = ? AND superseded_by IS NULL ORDER BY importance DESC, created_at DESC LIMIT 1`,
      )
      .get(Number(r.id)) as { content: string } | undefined;
    const obsSnippet = topObs ? topObs.content.replace(/\s+/g, ' ').slice(0, 80) : '';
    const line = obsSnippet
      ? `- [${r.id}] ${r.name} (${r.entity_type}): ${obsSnippet}`
      : `- [${r.id}] ${r.name} (${r.entity_type})`;
    return {
      id: Number(r.id),
      name: String(r.name),
      type: String(r.entity_type),
      line,
      score: Math.round(score * 1000) / 1000,
      tokens: estimateTokens(line),
    };
  });

  scored.sort((a, b) => {
    // pinned first, then score
    const pa = rows.find((r) => Number(r.id) === a.id)?.pinned ? 1 : 0;
    const pb = rows.find((r) => Number(r.id) === b.id)?.pinned ? 1 : 0;
    if (pb !== pa) return pb - pa;
    return b.score - a.score;
  });
  return scored.slice(0, limit);
}

export function pinnedFacts(
  db: Database.Database,
  project: string,
): Array<{ line: string; tokens: number }> {
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.entity_type FROM entities e
       WHERE e.project = ? AND e.pinned = 1 AND e.archived = 0`,
    )
    .all(project) as Array<Record<string, unknown>>;
  const out: Array<{ line: string; tokens: number }> = [];
  for (const r of rows) {
    const obs = db
      .prepare(
        `SELECT content FROM observations WHERE entity_id = ? AND superseded_by IS NULL ORDER BY importance DESC, created_at DESC LIMIT 3`,
      )
      .all(Number(r.id)) as Array<{ content: string }>;
    for (const o of obs) {
      const line = `- [${r.id}] ${r.name}: ${o.content.replace(/\s+/g, ' ').slice(0, 200)}`;
      out.push({ line, tokens: estimateTokens(line) });
    }
  }
  return out;
}

export function latestSessionSummary(
  db: Database.Database,
  project: string,
): { summary: string; token_count: number } | null {
  const row = db
    .prepare(
      `SELECT summary, token_count FROM session_summaries WHERE project = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(project) as { summary: string; token_count: number } | undefined;
  return row ?? null;
}

export function buildContextMarkdown(
  db: Database.Database,
  project: string,
  budget: number,
): { markdown: string; tokens: number; truncated: boolean } {
  const sections: string[] = [];
  let used = 0;
  const header = `# Memory context for project: ${project}\n`;
  sections.push(header);
  used += estimateTokens(header);

  // Pinned facts first.
  const pinned = pinnedFacts(db, project);
  if (pinned.length) {
    const h = '## Pinned facts\n';
    if (used + estimateTokens(h) <= budget) {
      sections.push(h);
      used += estimateTokens(h);
      for (const p of pinned) {
        if (used + p.tokens > budget) break;
        sections.push(`${p.line}\n`);
        used += p.tokens;
      }
    }
  }

  // Top-N ranked index.
  const topN = 12;
  const ranked = rankEntitiesForContext(db, project, topN);
  const h2 = '## Memory index (top ranked)\n';
  if (used + estimateTokens(h2) <= budget) {
    sections.push(h2);
    used += estimateTokens(h2);
    for (const r of ranked) {
      if (used + r.tokens > budget) break;
      sections.push(`${r.line}\n`);
      used += r.tokens;
    }
  }

  // Latest session summary.
  const ss = latestSessionSummary(db, project);
  if (ss) {
    const h3 = '## Last session summary\n';
    const body = `${ss.summary}\n`;
    const cost = estimateTokens(h3) + estimateTokens(body);
    if (used + cost <= budget) {
      sections.push(h3);
      used += estimateTokens(h3);
      sections.push(body);
      used += estimateTokens(body);
    }
  }

  const markdown = sections.join('');
  return { markdown, tokens: used, truncated: used >= budget };
  // note: truncated flag approximated; fine.
}

export function logTokenLedger(
  db: Database.Database,
  params: { project: string; kind: string; tokensIn: number; tokensOut: number; note?: string },
): void {
  db.prepare(
    `INSERT INTO token_ledger (project, kind, tokens_in, tokens_out, note) VALUES (?, ?, ?, ?, ?)`,
  ).run(params.project, params.kind, params.tokensIn, params.tokensOut, params.note ?? null);
}
