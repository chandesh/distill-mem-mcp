import type Database from 'better-sqlite3';

export type EntityRef = number | string;

export type ResolveResult = { ok: true; id: number } | { ok: false; error: string };

export function resolveEntity(
  db: Database.Database,
  project: string,
  ref: EntityRef,
): ResolveResult {
  const column = typeof ref === 'number' ? 'id' : 'name';
  const rows = db
    .prepare(`SELECT id FROM entities WHERE ${column} = ? AND project = ?`)
    .all(ref, project) as Array<{ id: number }>;

  if (rows.length === 0) {
    const label = typeof ref === 'number' ? String(ref) : `'${ref}'`;
    return { ok: false, error: `entity ${label} not found in project ${project}` };
  }
  if (rows.length > 1) {
    const ids = rows.map((row) => row.id).join(', ');
    return {
      ok: false,
      error: `entity '${ref}' is ambiguous in project ${project}; candidate ids: ${ids}`,
    };
  }
  const row = rows[0];
  if (!row) {
    const label = typeof ref === 'number' ? String(ref) : `'${ref}'`;
    return { ok: false, error: `entity ${label} not found in project ${project}` };
  }
  return { ok: true, id: row.id };
}
