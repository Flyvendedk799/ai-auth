/**
 * `@flyvendedk799/ai-auth` — the Node entry point.
 *
 * Everything here runs on the server and has no runtime dependencies: node built-ins only.
 * The two optional halves live behind their own entry points so that installing this package
 * never obliges you to have Fastify or React —
 *
 *     @flyvendedk799/ai-auth/fastify    the four routes for the browser login
 *     @flyvendedk799/ai-auth/react      the terminal-shell login component
 *     @flyvendedk799/ai-auth/postgres   the Postgres credential store
 */

// --- Claude: a subscription the user signs in to, here ------------------------
export {
  CLAUDE_OAUTH,
  ClaudeLoginError,
  exchangeClaudeCode,
  parsePastedCode,
  sameState,
  startClaudeLogin,
  type ExchangedIdentity,
  type LoginStart,
} from './claude/oauth.js';

// --- Claude: a subscription already signed in on this machine ----------------
export {
  ClaudeCodeAuthError,
  ClaudeCodeCredential,
  isExpired as isClaudeExpired,
  parseClaudeCredentials,
  readClaudeCodeLogin,
  refreshClaudeCodeToken,
  type ClaudeCodeIdentity,
  type HarvestOptions,
} from './claude/localCli.js';

export {
  ClaudeAccountStore,
  type ClaudeAccountStatus,
  type ClaudeAccountStoreOptions,
  type ClaudeIdentityInput,
} from './claude/accountStore.js';

// --- Codex: a ChatGPT subscription signed in on this machine -----------------
export {
  accountIdFromToken,
  CodexAuthError,
  CodexCredential,
  decodeJwtClaims,
  isCodexExpired,
  parseCodexAuth,
  readCodexLogin,
  type CodexHarvestOptions,
  type CodexIdentity,
} from './codex/localCli.js';

// --- API keys ----------------------------------------------------------------
export { ApiKeyStore, type ApiKeyStoreOptions, type KeySource, type ResolvedKey } from './keys/keyStore.js';
export { maskSecret, SecretBox } from './keys/secretBox.js';

// --- Storage -----------------------------------------------------------------
export {
  MemoryCredentialStore,
  type CredentialStore,
  type StoredRecord,
} from './store/types.js';
export { JsonFileCredentialStore, type JsonFileStoreOptions } from './store/jsonFile.js';

// --- Which provider, what it costs, and what went wrong ----------------------
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
} from './registry/pricing.js';

export {
  MODELS,
  modelSpec,
  modelsFor,
  pricingKeyFor,
  type ModelSpec,
  type ModelTier,
} from './registry/models.js';

export {
  describeProviderError,
  providerErrorFacts,
  type DescribeOptions,
  type ProviderErrorFacts,
} from './registry/errors.js';

// --- Configuring an SDK client ----------------------------------------------
export {
  CLAUDE_CODE_SYSTEM,
  withClaudeCodeIdentity,
  type SystemBlock,
} from './clients/identity.js';

export {
  anthropicKeyOptions,
  anthropicSubscriptionOptions,
  CLAUDE_CODE_BETA,
  CLAUDE_CODE_VERSION,
  CODEX_BASE_URL,
  codexOptions,
  openAiKeyOptions,
  type AnthropicClientOptions,
  type OpenAiClientOptions,
} from './clients/options.js';
