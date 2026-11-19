import { estimateTokens } from '../core/tokens.js';

const PREVIEW_CHARS = 200;

export interface ToolCallEntry {
  name: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
  at: Date;
}

function payloadText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value && typeof value === 'object' && 'content' in value) {
    const blocks = (value as { content?: unknown }).content;
    if (Array.isArray(blocks)) {
      const texts = blocks.flatMap((block) =>
        block && typeof block === 'object' && 'text' in block
          ? [String((block as { text: unknown }).text)]
          : [],
      );
      if (texts.length > 0) return texts.join('\n');
    }
  }
  return JSON.stringify(value) ?? String(value);
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > PREVIEW_CHARS ? `${collapsed.slice(0, PREVIEW_CHARS)}…` : collapsed;
}

export function logged<TInput, TResult>(
  name: string,
  handler: (input: TInput) => Promise<TResult> | TResult,
): (input: TInput) => Promise<TResult> {
  return async (input) => {
    const at = new Date();
    try {
      const output = await handler(input);
      process.stderr.write(`${formatToolCall({ name, input, output, at })}\n`);
      return output;
    } catch (error) {
      process.stderr.write(`${formatToolCall({ name, input, error, at })}\n`);
      throw error;
    }
  };
}

export function formatToolCall(entry: ToolCallEntry): string {
  const status = entry.error === undefined ? 'ok' : 'error';
  const payload = status === 'ok' ? entry.output : entry.error;
  const request = payloadText(entry.input);
  const response = payloadText(payload);
  return (
    `[mcp] ${entry.at.toISOString()} ${entry.name} ` +
    `in=${estimateTokens(request)} out=${estimateTokens(response)} ${status} ` +
    `req=${oneLine(request)} res=${oneLine(response)}`
  );
}
