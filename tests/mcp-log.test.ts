import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateTokens } from '../src/core/tokens.js';
import { formatToolCall, logged } from '../src/mcp/log.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mcp call logging', () => {
  it('formats a tool call with request and response token counts', () => {
    const input = { project: 'p', query: 'Foo' };
    const output = { content: [{ type: 'text' as const, text: '{"results":[]}' }] };

    const line = formatToolCall({
      name: 'search',
      input,
      output,
      at: new Date('2026-11-19T10:00:00.000Z'),
    });

    expect(line).toBe(
      `[mcp] 2026-11-19T10:00:00.000Z search ` +
        `in=${estimateTokens(JSON.stringify(input))} ` +
        `out=${estimateTokens('{"results":[]}')} ` +
        `ok req=${JSON.stringify(input)} res={"results":[]}`,
    );
  });

  it('truncates previews but counts tokens from the full payload', () => {
    const long = 'x'.repeat(400);
    const input = { project: 'p', observations: [long] };

    const line = formatToolCall({
      name: 'remember',
      input,
      output: { content: [{ type: 'text' as const, text: 'ok' }] },
      at: new Date('2026-11-19T10:00:00.000Z'),
    });

    const requestPreview = line.match(/ req=(.*) res=/)?.[1] ?? '';
    expect(line).toContain(`in=${estimateTokens(JSON.stringify(input))}`);
    expect(requestPreview).toHaveLength(201);
    expect(requestPreview.endsWith('…')).toBe(true);
    expect(requestPreview.includes(long)).toBe(false);
  });

  it('writes one log line for a successful tool call and returns the result', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = { content: [{ type: 'text' as const, text: '{"results":[]}' }] };
    const handler = logged('search', async (_input: unknown) => result);
    const input = { project: 'p' };

    const actual = await handler(input);

    expect(actual).toBe(result);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain(
      ` search in=${estimateTokens(JSON.stringify(input))} `,
    );
    expect(String(write.mock.calls[0]?.[0])).toContain(
      ' ok req={"project":"p"} res={"results":[]}',
    );
  });

  it('writes an error log line and rethrows the original error', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const failure = new Error('db exploded');
    const handler = logged('remember', async (_input: unknown) => {
      throw failure;
    });
    const input = { project: 'p' };

    await expect(handler(input)).rejects.toBe(failure);

    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line).toContain(' error req={"project":"p"} res=');
    expect(line).toContain('db exploded');
  });
});
