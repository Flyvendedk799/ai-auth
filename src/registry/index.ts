/**
 * `@flyvendedk799/ai-auth/registry` — the part that runs anywhere.
 *
 * Which provider, which model, what it weighs, what it costs, and how to read a failure. None
 * of it touches a credential, a filesystem or `node:crypto`, so it is safe in a browser
 * bundle — which the main entry point is emphatically not.
 *
 * That distinction is the reason this file exists. A settings page needs the model catalogue
 * and the pricing table; importing them from the package root dragged the OAuth exchange and
 * its `node:crypto` import into the client build, where the bundler could only fail. Splitting
 * the pure half out costs one entry point and means a browser never ships an inch of the
 * credential handling.
 */

export {
  costOf,
  formatUsd,
  FREE,
  isPricingKnown,
  isSubscription,
  PRICING,
  pricingFor,
  providerOf,
  SUBSCRIPTION_PROVIDERS,
  UNKNOWN_MODEL_PRICING,
  wireOf,
  worstCaseCost,
  type CostBreakdown,
  type ModelId,
  type ModelPricing,
  type ProviderId,
  type TokenUsage,
} from './pricing.js';

export {
  MODELS,
  modelSpec,
  modelsFor,
  pricingKeyFor,
  type ModelSpec,
  type ModelTier,
} from './models.js';

export {
  describeProviderError,
  providerErrorFacts,
  type DescribeOptions,
  type ProviderErrorFacts,
} from './errors.js';
