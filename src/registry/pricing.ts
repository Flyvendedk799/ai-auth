/**
 * Model pricing and cost accounting.
 *
 * Rates are deliberately the *standard* published rates, not promotional ones. Under-
 * estimating spend is the dangerous direction: it would let the budget guard wave through
 * a call that actually costs more than it thinks. Over-estimating only means the ceiling
 * bites slightly early, which is the safe failure.
 */

import { pricingKeyFor } from './models.js';


/**
 * A model name. A plain string rather than a union because the provider and model are now
 * chosen at runtime, so the set is not known at compile time.
 */
export type ModelId = string;

/**
 * Who to call and how the call is paid for.
 *
 * Four, and the split is by *billing*, not by vendor. `anthropic` and `openai` are metered
 * API keys: every token has a published price, so a ledger can add it up and a budget guard
 * can refuse a call before it is made. `claude-code` and `codex` are subscriptions —
 * the same wires, the same endpoints, but paid for by a plan that has already been bought.
 * There is no per-token price to charge, so the ledger records them at zero and the budget
 * guard has nothing to guard. Modelling them as a *provider* rather than as a flag on one is
 * what keeps that distinction in one place instead of in every call site.
 */
export type ProviderId = 'anthropic' | 'openai' | 'claude-code' | 'codex';

/**
 * Providers billed to a plan rather than by the token.
 *
 * A call still costs the user something — a slice of their plan's rate limit — but it costs
 * this *deployment* nothing, and the ledger exists to protect the deployment's card. Charging
 * a subscription call the API rate would make the budget guard refuse work that is free to it.
 */
export const SUBSCRIPTION_PROVIDERS: readonly ProviderId[] = ['claude-code', 'codex'];

export function isSubscription(provider: ProviderId): boolean {
  return SUBSCRIPTION_PROVIDERS.includes(provider);
}

/** The wire a provider speaks, which is not the same question as who bills for it. */
export function wireOf(provider: ProviderId): 'anthropic' | 'openai' {
  return provider === 'anthropic' || provider === 'claude-code' ? 'anthropic' : 'openai';
}

export interface ModelPricing {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/** USD per million tokens. Verify against the provider's pricing page before changing. */
export const PRICING: Record<string, ModelPricing> = {
  // Sonnet 5 had promotional $2/$10 rates into 2026; budgeting uses the standard rates.
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },

  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'o4-mini': { input: 1.1, output: 4.4 },
};

/**
 * What an unlisted model is assumed to cost.
 *
 * Deliberately expensive. A model can now be typed into a settings field, so the table will
 * fall behind, and the budget guard must never be the thing that discovers it — guessing low
 * would wave through a call costing several times the estimate. Guessing high only makes the
 * ceiling bite early, which is recoverable. This is priced above every model listed above.
 */
export const UNKNOWN_MODEL_PRICING: ModelPricing = { input: 15.0, output: 75.0 };

export function pricingFor(model: ModelId): ModelPricing {
  const key = pricingKeyFor(model);
  return (key !== null ? PRICING[key] : undefined) ?? UNKNOWN_MODEL_PRICING;
}

/** True when the model is priced from the table rather than the pessimistic fallback. */
export function isPricingKnown(model: ModelId): boolean {
  return pricingKeyFor(model) !== null;
}

/**
 * Which provider a model belongs to, inferred from its name.
 *
 * Answers with a metered provider on purpose. It is used where only a model name is in hand —
 * a ledger row read back from disk — and the metered rate is the conservative reading: a
 * subscription call recorded at zero stays at zero because its *cost* is stored, not
 * recomputed, while an unknown row is better over-counted than under-counted.
 */
export function providerOf(model: ModelId): ProviderId {
  return model.startsWith('claude') ? 'anthropic' : 'openai';
}

/** Cache writes cost more than fresh input; cache reads cost a fraction of it. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheWriteUsd: number;
  cacheReadUsd: number;
  totalUsd: number;
}

/** Nothing was spent, and every field says so. Used for the subscription providers. */
export const FREE: CostBreakdown = {
  inputUsd: 0,
  outputUsd: 0,
  cacheWriteUsd: 0,
  cacheReadUsd: 0,
  totalUsd: 0,
};

export function costOf(model: ModelId, usage: TokenUsage, provider?: ProviderId): CostBreakdown {
  // A plan has already been paid for, so there is no per-token amount to attribute and
  // nothing for the budget to subtract. The token counts are still reported to the caller —
  // they are the honest measure of what a generation took — but they cost this deployment
  // nothing and the ledger must not pretend otherwise.
  if (provider && isSubscription(provider)) return FREE;

  const rates = pricingFor(model);
  const perToken = (perMillion: number) => perMillion / 1_000_000;

  const inputUsd = usage.input_tokens * perToken(rates.input);
  const outputUsd = usage.output_tokens * perToken(rates.output);
  const cacheWriteUsd =
    (usage.cache_creation_input_tokens ?? 0) * perToken(rates.input) * CACHE_WRITE_MULTIPLIER;
  const cacheReadUsd =
    (usage.cache_read_input_tokens ?? 0) * perToken(rates.input) * CACHE_READ_MULTIPLIER;

  return {
    inputUsd,
    outputUsd,
    cacheWriteUsd,
    cacheReadUsd,
    totalUsd: inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd,
  };
}

/**
 * Worst-case cost of a call before making it, used by the budget guard.
 *
 * Assumes `max_tokens` are all produced, because the guard has to reason about what a call
 * *could* cost, not what a typical one does.
 */
export function worstCaseCost(
  model: ModelId,
  estimatedInputTokens: number,
  maxTokens: number,
  provider?: ProviderId,
): number {
  if (provider && isSubscription(provider)) return 0;
  const rates = pricingFor(model);
  return (estimatedInputTokens * rates.input + maxTokens * rates.output) / 1_000_000;
}

export function formatUsd(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
