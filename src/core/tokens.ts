/**
 * Cheap, deterministic token estimator. No tokenizer dependency on the hot path.
 * Approximates OpenAI/Anthropic token counts within ~10% for English text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 4 chars per token baseline, plus a small overhead for whitespace/punctuation.
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(chars / 4) + Math.ceil(words / 100));
}

export function truncateToTokens(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;
  // Binary search on character length.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

export function fitsBudget(items: Array<{ tokens: number }>, budget: number): number {
  let used = 0;
  let count = 0;
  for (const item of items) {
    if (used + item.tokens > budget) break;
    used += item.tokens;
    count += 1;
  }
  return count;
}
