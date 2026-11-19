import { createHash } from 'node:crypto';

const NOISE_TOOLS = new Set([
  'Read',
  'read_file',
  'Glob',
  'Grep',
  'LS',
  'list_dir',
  'list_directory',
  'file_search',
]);

const OUTPUT_FIELDS = ['tool_response', 'output', 'stdout', 'stderr', 'result', 'content'];

export interface CleanedEvent {
  kind: string;
  payload: Record<string, unknown>;
  hash: string;
  dropped: boolean;
}

export function truncateText(value: string, cap: number): string {
  if (value.length <= cap) return value;
  return `${value.slice(0, cap)}\n...[truncated ${value.length - cap} chars]`;
}

export function truncateDeep(value: unknown, cap: number, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return truncateText(value, cap);
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, cap, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateDeep(v, cap, depth + 1);
    }
    return out;
  }
  return value;
}

export function deriveProject(cwd?: string): string {
  if (!cwd) return 'default';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? (parts[parts.length - 1] as string) : 'default';
}

export function cleanHookPayload(
  raw: Record<string, unknown>,
  outputCap: number,
): CleanedEvent | null {
  const hookEvent = String(raw.hook_event_name ?? raw.event ?? 'unknown');
  const toolName = String(raw.tool_name ?? raw.tool ?? '');

  // Drop plain noise tools unless they errored.
  const isError =
    raw.is_error === true ||
    (typeof raw.tool_response === 'object' &&
      raw.tool_response !== null &&
      (raw.tool_response as Record<string, unknown>).is_error === true);
  if (toolName && NOISE_TOOLS.has(toolName) && !isError) {
    return null;
  }

  const payload: Record<string, unknown> = { ...raw };
  for (const field of OUTPUT_FIELDS) {
    const v = payload[field];
    if (typeof v === 'string') {
      payload[field] = truncateText(v, outputCap);
    } else if (v && typeof v === 'object') {
      payload[field] = truncateDeep(v, outputCap);
    }
  }

  const kind = toolName ? `${hookEvent}:${toolName}` : hookEvent;
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  return { kind, payload, hash, dropped: false };
}

export function isNoiseTool(toolName: string): boolean {
  return NOISE_TOOLS.has(toolName);
}
