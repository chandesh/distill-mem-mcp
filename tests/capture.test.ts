import { describe, expect, it } from 'vitest';
import { cleanHookPayload, truncateText } from '../src/core/capture.js';

describe('capture', () => {
  it('drops noise read tool', () => {
    const r = cleanHookPayload(
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { path: 'x' } },
      100,
    );
    expect(r).toBeNull();
  });
  it('keeps bash command', () => {
    const r = cleanHookPayload(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: 'out',
      },
      100,
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toContain('Bash');
  });
  it('truncates large output', () => {
    const r = cleanHookPayload(
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'a'.repeat(500) },
      50,
    );
    expect((r!.payload.tool_response as string).length).toBeLessThan(500);
  });
  it('truncateText', () => {
    expect(truncateText('abc', 10)).toBe('abc');
  });
});
