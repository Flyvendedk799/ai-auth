/**
 * The models worth offering, and how heavy each one is.
 *
 * A catalogue rather than a hardcoded list in one app's settings page, because two separate
 * things need to agree about it: whatever renders a chooser, and whatever prices a call. When
 * they disagree you get a picker offering a model the ledger has never heard of.
 *
 * `tier` is the field that earns this file. A subscription meters each model on its **own**
 * allowance, so a heavy model can be refused for hours while a light one answers every request
 * — and the fastest fix for that 429 is to pick something lighter. A chooser that shows only
 * names cannot help anyone do that; one that shows weight can. It is a deliberately coarse
 * three-way split, because the decision it supports is coarse.
 *
 * The list is not a closed set. Providers ship models faster than any dependency updates, so
 * every caller here still accepts a typed-in id — this is the shortcut, not the gate.
 */

import { PRICING, wireOf, type ModelId, type ProviderId } from './pricing.js';

/** How much the model costs you, in plan allowance or in money. */
export type ModelTier = 'light' | 'balanced' | 'heavy';

export interface ModelSpec {
  id: ModelId;
  /** For a chooser. The vendor's own name for it, not the wire id. */
  label: string;
  wire: 'anthropic' | 'openai' | 'gemini';
  tier: ModelTier;
  /** One line on when to reach for it. */
  note: string;
}

export const MODELS: readonly ModelSpec[] = [
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    wire: 'anthropic',
    tier: 'light',
    note: 'Fastest and cheapest. The one still answering when a plan refuses the others.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    wire: 'anthropic',
    tier: 'balanced',
    note: 'The usual choice — strong output without Opus prices.',
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    wire: 'anthropic',
    tier: 'heavy',
    note: 'Most capable, strictest allowance, highest rate.',
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 mini',
    wire: 'openai',
    tier: 'light',
    note: 'Fast and cheap.',
  },
  {
    id: 'gpt-5',
    label: 'GPT-5',
    wire: 'openai',
    tier: 'balanced',
    note: 'The usual choice on the OpenAI wire.',
  },
  {
    id: 'o4-mini',
    label: 'o4-mini',
    wire: 'openai',
    tier: 'light',
    note: 'Reasoning model, small.',
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    wire: 'openai',
    tier: 'balanced',
    note: 'Previous generation, still solid.',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    wire: 'gemini',
    tier: 'light',
    note: 'Fastest, large context, lightweight workhorse.',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    wire: 'gemini',
    tier: 'balanced',
    note: 'Complex reasoning, coding, and large-context synthesis.',
  },
  {
    id: 'gemini-3-flash',
    label: 'Gemini 3 Flash',
    wire: 'gemini',
    tier: 'light',
    note: 'Next-gen fast reasoning model.',
  },
  {
    id: 'gemini-3-pro',
    label: 'Gemini 3 Pro',
    wire: 'gemini',
    tier: 'heavy',
    note: 'Next-gen flagship reasoning model.',
  },
];

/** The models that make sense for a provider, lightest first. */
export function modelsFor(provider: ProviderId): ModelSpec[] {
  const wire = wireOf(provider);
  const order: Record<ModelTier, number> = { light: 0, balanced: 1, heavy: 2 };
  return MODELS.filter((model) => model.wire === wire).sort(
    (a, b) => order[a.tier] - order[b.tier],
  );
}

export function modelSpec(id: ModelId): ModelSpec | null {
  return MODELS.find((model) => model.id === id) ?? null;
}

/**
 * The pricing table's key for a model id, allowing for a dated suffix.
 *
 * Vendors publish both `claude-haiku-4-5` and `claude-haiku-4-5-20251001`, and the second is
 * the one you actually call. Exact-matching the table meant the dated id fell through to the
 * pessimistic unknown-model rate — so a correctly configured deployment was told its model had
 * no published price and its budget guard quietly priced it at five times the truth.
 *
 * Longest match wins, so `gpt-4.1-mini` cannot be swallowed by `gpt-4.1`.
 */
export function pricingKeyFor(model: ModelId): ModelId | null {
  if (PRICING[model]) return model;
  let best: ModelId | null = null;
  for (const key of Object.keys(PRICING)) {
    if (!model.startsWith(key)) continue;
    // A dated suffix, not a different model: `gpt-4.1-mini` must not match `gpt-4.1`.
    const rest = model.slice(key.length);
    if (!/^-\d{6,8}$/.test(rest)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best;
}
