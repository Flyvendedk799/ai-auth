/**
 * How to configure an SDK client for each way of paying.
 *
 * These return *options objects*, not clients. Neither `@anthropic-ai/sdk` nor `openai` is a
 * dependency of this package and neither is imported anywhere in it, which means a consumer
 * keeps control of their own SDK version, pays nothing for the one they do not use, and can
 * install this library into a project that talks to the APIs over plain `fetch`.
 *
 *     const anthropic = new Anthropic(await anthropicOptions({ kind: 'subscription', token }));
 *     const openai = new OpenAI(codexOptions(identity));
 *
 * What is actually being carried here is a set of details that are individually small and each
 * cost a day to find out. They are the reason this file exists.
 */

import type { CodexIdentity } from '../codex/localCli.js';
import type { AntigravityOAuthIdentity } from '../antigravity/oauth.js';

/**
 * The Claude Code client version this presents as.
 *
 * Anthropic gates the OAuth-authenticated path on looking like the CLI. Bump it if a future
 * release starts refusing this one; it is not otherwise load-bearing.
 */
export const CLAUDE_CODE_VERSION = '2.1.75';

/** The beta flags a real Claude Code session sends. Read off the wire, not chosen. */
export const CLAUDE_CODE_BETA = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14',
].join(',');

/** Codex speaks the OpenAI Responses API at its own host, not at `api.openai.com`. */
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/** Standard Google AI Studio API base URL for metered API keys. */
export const antigravity_STUDIO_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface AnthropicClientOptions {
  apiKey: string | null;
  authToken?: string;
  defaultHeaders?: Record<string, string>;
}

export interface OpenAiClientOptions {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}

export interface AntigravityClientOptions {
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  projectId?: string;
}

/** A metered Anthropic API key. Nothing surprising; here for symmetry with the other three. */
export function anthropicKeyOptions(apiKey: string): AnthropicClientOptions {
  return { apiKey };
}

/**
 * The same Anthropic wire, paid for by a subscription instead of a key.
 *
 * `authToken` rather than `apiKey`, and this is the one detail that has to be exactly right.
 * The SDK sends `Authorization: Bearer` for the former and `x-api-key` for the latter, and
 * Anthropic validates `x-api-key` whenever the header is *present*. A placeholder key
 * alongside a valid bearer token does not get ignored — it gets rejected, and the request
 * fails with "invalid x-api-key" while carrying a perfectly good credential.
 *
 * So `apiKey` is set to `null` explicitly rather than merely omitted: left out, the SDK falls
 * back to `ANTHROPIC_API_KEY` from the environment, and a machine that has both a key and a
 * subscription would send the key alongside the bearer and 401 — on a box where everything
 * looks correctly configured, which is the worst place for this to happen.
 *
 * **These options are not sufficient on their own.** Every request made with them must also
 * open with the Claude Code identity system block — see `withClaudeCodeIdentity`. Without it
 * Anthropic refuses Opus and Sonnet with a 429 that names a rate limit the plan is nowhere
 * near, while Haiku answers normally. A client built from here and used without the block
 * works perfectly on the model you test with and fails on every model you want.
 */
export function anthropicSubscriptionOptions(accessToken: string): AnthropicClientOptions {
  return {
    authToken: accessToken,
    apiKey: null,
    defaultHeaders: {
      'anthropic-beta': CLAUDE_CODE_BETA,
      'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
      'x-app': 'cli',
    },
  };
}

/** A metered OpenAI API key. */
export function openAiKeyOptions(apiKey: string): OpenAiClientOptions {
  return { apiKey };
}

/**
 * Codex, on a ChatGPT subscription.
 *
 * The account header is not optional in practice: without it the backend cannot tell which
 * subscription to bill and refuses the request. It is why `CodexIdentity` goes to the trouble
 * of digging the account id out of the token's claims rather than settling for the token.
 */
export function codexOptions(identity: CodexIdentity, baseUrl = CODEX_BASE_URL): OpenAiClientOptions {
  return {
    apiKey: identity.accessToken,
    baseURL: baseUrl,
    defaultHeaders: {
      ...(identity.accountId ? { 'chatgpt-account-id': identity.accountId } : {}),
      originator: 'codex_cli_ts',
    },
  };
}

/** A metered Google AI Studio API key. */
export function antigravityKeyOptions(apiKey: string, baseUrl = antigravity_STUDIO_BASE_URL): AntigravityClientOptions {
  return {
    apiKey,
    baseURL: baseUrl,
  };
}

/**
 * antigravity CLI, on a Google account subscription (Code Assist, personal free tier, G1 credits).
 *
 * Directs calls to Google's internal Cloud Code endpoint (`https://cloudcode-pa.googleapis.com/v1internal`).
 */
export function antigravityCliOptions(
  identity: AntigravityOAuthIdentity & { projectId?: string | null },
  baseUrl?: string,
): AntigravityClientOptions {
  const isDogfoodUser = identity.isDogfood ?? false;
  const resolvedBaseUrl = baseUrl ?? (isDogfoodUser 
    ? 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    : 'https://cloudcode-pa.googleapis.com/v1internal');

  const effectiveProjectId = identity.projectId || null;

  return {
    authToken: identity.accessToken,
    baseURL: resolvedBaseUrl,
    projectId: effectiveProjectId ?? undefined,
    defaultHeaders: {
      Authorization: `Bearer ${identity.accessToken}`,
      'Content-Type': 'application/json',
      ...(effectiveProjectId ? { 'x-goog-user-project': effectiveProjectId } : {}),
    },
  };
}

export interface CodeAssistContentPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface CodeAssistContent {
  role?: 'user' | 'model' | 'system';
  parts: CodeAssistContentPart[];
}

export interface CodeAssistGenerateRequest {
  model: string;
  project?: string;
  user_prompt_id?: string;
  request: {
    contents: CodeAssistContent[];
    systemInstruction?: CodeAssistContent;
  };
}

/**
 * Format a generation payload for the internal Cloud Code / Code Assist endpoint.
 */
export function toCodeAssistRequest(
  model: string,
  contents: CodeAssistContent[] | string,
  options: { projectId?: string; systemInstruction?: string; userPromptId?: string } = {},
): CodeAssistGenerateRequest {
  const normalizedContents: CodeAssistContent[] =
    typeof contents === 'string'
      ? [{ role: 'user', parts: [{ text: contents }] }]
      : contents;

  return {
    model: model.startsWith('models/') ? model : `models/${model}`,
    ...(options.projectId ? { project: options.projectId } : {}),
    ...(options.userPromptId ? { user_prompt_id: options.userPromptId } : {}),
    request: {
      contents: normalizedContents,
      ...(options.systemInstruction
        ? { systemInstruction: { role: 'system', parts: [{ text: options.systemInstruction }] } }
        : {}),
    },
  };
}

