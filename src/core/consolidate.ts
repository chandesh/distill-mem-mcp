/**
 * Phase 2 (future): batched, budget-capped consolidation. LLM calls are optional
 * and never run on the hot path. This module only defines the interface/config.
 */

export type ConsolidationProvider = 'none' | 'anthropic' | 'ollama';

export interface ConsolidationConfig {
  provider: ConsolidationProvider;
  model?: string;
  monthlyTokenBudget: number;
  batchSize: number;
  enabled: boolean;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  provider: 'none',
  monthlyTokenBudget: 0,
  batchSize: 50,
  enabled: false,
};

export interface ConsolidationJob {
  project: string;
  runAt: Date;
}

export interface ConsolidationResult {
  eventsSummarized: number;
  factsExtracted: number;
  duplicatesMerged: number;
  contradictionsSuperseded: number;
  archived: number;
  tokensUsed: number;
}

/**
 * Planned pipeline (not implemented in v1):
 * 1. Summarize unconsolidated events into session_summaries.
 * 2. Extract durable facts into entities/observations.
 * 3. Merge near-duplicates (by content_hash + fuzzy match).
 * 4. Supersede contradicted facts.
 * 5. Decay and archive stale items.
 */
export async function runConsolidation(
  _job: ConsolidationJob,
  _config: ConsolidationConfig,
): Promise<ConsolidationResult> {
  throw new Error('Consolidation is not implemented in v1');
}
