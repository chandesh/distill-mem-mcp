const MS_PER_DAY = 86_400_000;

export interface DecayInput {
  lastAccessedAt: string | null;
  createdAt: string;
  importance: number;
  pinned: boolean;
  archived: boolean;
}

export function daysSince(iso: string | null, now: Date = new Date()): number {
  if (!iso) return 30;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 30;
  return Math.max(0, (now.getTime() - t) / MS_PER_DAY);
}

export function decayFactor(input: DecayInput, now: Date = new Date()): number {
  if (input.archived) return 0;
  if (input.pinned) return 1;
  const anchor = input.lastAccessedAt ?? input.createdAt;
  const days = daysSince(anchor, now);
  // Half-life grows with importance: 7 days at importance 0.1, ~60 days at 1.0.
  const halfLife = 7 + input.importance * 53;
  return 0.5 ** (days / halfLife);
}

export function recencyScore(iso: string | null, now: Date = new Date()): number {
  const d = daysSince(iso, now);
  return 1 / (1 + d);
}
