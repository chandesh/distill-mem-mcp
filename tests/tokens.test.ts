import { describe, expect, it } from 'vitest';
import { estimateTokens, fitsBudget, truncateToTokens } from '../src/core/tokens.js';

describe('tokens', () => {
  it('estimates positive', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });
  it('truncate never exceeds budget', () => {
    const text = 'a'.repeat(1000);
    const out = truncateToTokens(text, 10);
    expect(estimateTokens(out)).toBeLessThanOrEqual(10);
  });
  it('fitsBudget counts', () => {
    const items = [{ tokens: 5 }, { tokens: 5 }, { tokens: 5 }];
    expect(fitsBudget(items, 12)).toBe(2);
  });
});
