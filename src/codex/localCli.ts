/**
 * Harvest the Codex / ChatGPT subscription login that is already on this machine.
 *
 * The counterpart to `claude/localCli.ts`: the `codex` CLI, once signed in with a ChatGPT
 * subscription rather than an API key, leaves an OAuth credential at `~/.codex/auth.json`.
 * Calls made with it are billed to the plan.
 *
 * One difference from the Claude side, and it is deliberate: **this never refreshes.** The
 * `codex` CLI keeps its own token fresh, and OpenAI rotates the refresh token on exchange — so
 * a refresh performed here would hand the server a token the CLI does not have and leave the
 * CLI holding one that has been spent. Breaking the user's own CLI to save them one sign-in is
 * a bad trade. When the token has expired the answer is "run `codex` again", which costs the
 * user nothing because the CLI refreshes on start.
 *
 * The file has no `expires_in`; the expiry is in the access token's own JWT claims.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Treat a token as spent this long before it really expires, so a call cannot race it. */
const EXPIRY_BUFFER_MS = 60_000;

export interface CodexIdentity {
  accessToken: string;
  /** Present in the file, and deliberately unused. See the note at the top. */
  refreshToken: string | null;
  /**
   * The ChatGPT account the plan belongs to.
   *
   * Sent as a header on every call. Without it the backend cannot tell which subscription to
   * bill and rejects the request, which is why it is harvested rather than inferred.
   */
  accountId: string | null;
  /** Unix ms, decoded from the access token. */
  expiresAt: number;
  email: string | null;
  /** `plus`, `pro`, `team`, … when the token says so. */
  planType: string | null;
}

export class CodexAuthError extends Error {
  constructor(
    message: string,
    readonly needsLogin: boolean,
  ) {
    super(message);
    this.name = 'CodexAuthError';
  }
}

function authPath(env: NodeJS.ProcessEnv): string {
  return env.CODEX_AUTH_FILE || join(homedir(), '.codex', 'auth.json');
}

/**
 * The claims of a JWT, without verifying it.
 *
 * Verification would need OpenAI's signing keys and would buy nothing: this token is not a
 * credential we are *accepting*, it is one we are about to *present*. The only thing read out
 * of it is when it expires and which account it belongs to, and being wrong about either
 * costs one rejected request.
 */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The ChatGPT account id, from wherever this token happens to carry it. */
export function accountIdFromToken(jwt: string): string | null {
  const claims = decodeJwtClaims(jwt);
  if (!claims) return null;

  const auth = claims['https://api.openai.com/auth'];
  if (typeof auth === 'object' && auth !== null) {
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === 'string' && id.length > 0) return id;
  }

  const orgs = claims.organizations;
  if (Array.isArray(orgs) && orgs.length > 0) {
    const first = orgs[0] as { id?: unknown };
    if (typeof first?.id === 'string' && first.id.length > 0) return first.id;
  }

  return null;
}

function planFromToken(jwt: string): string | null {
  const claims = decodeJwtClaims(jwt);
  const auth = claims?.['https://api.openai.com/auth'];
  if (typeof auth !== 'object' || auth === null) return null;
  const plan = (auth as Record<string, unknown>).chatgpt_plan_type;
  return typeof plan === 'string' && plan.length > 0 ? plan : null;
}

/**
 * Parse `~/.codex/auth.json`.
 *
 * Exported for its own tests. The CLI has written both `{ tokens: {...} }` and a flat object
 * over its life, and both snake_case and camelCase within, so all four shapes are accepted —
 * this is somebody else's file format and the cost of being generous is four `??`s.
 */
export function parseCodexAuth(raw: string): CodexIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const root = parsed as Record<string, unknown>;
  const nested = root.tokens;
  const tokens = (typeof nested === 'object' && nested !== null ? nested : root) as Record<string, unknown>;

  const accessToken = tokens.access_token ?? tokens.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;

  const refreshToken = tokens.refresh_token ?? tokens.refreshToken;
  const idTokenRaw = tokens.id_token ?? tokens.idToken;
  const idToken = typeof idTokenRaw === 'string' ? idTokenRaw : '';
  const direct = tokens.account_id ?? tokens.accountId;

  const claims = decodeJwtClaims(accessToken);
  const exp = claims?.exp;

  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : null,
    accountId:
      typeof direct === 'string' && direct.length > 0
        ? direct
        : accountIdFromToken(accessToken) ?? (idToken ? accountIdFromToken(idToken) : null),
    // No `exp` claim is treated as already expired, for the same reason as the Claude side: a
    // token wrongly assumed live fails in the middle of a generation instead of before one.
    expiresAt: typeof exp === 'number' && exp > 0 ? exp * 1000 : 0,
    email: typeof tokens.email === 'string' ? tokens.email : null,
    planType: planFromToken(accessToken) ?? (idToken ? planFromToken(idToken) : null),
  };
}

export interface CodexHarvestOptions {
  readFile?: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export async function readCodexLogin(options: CodexHarvestOptions = {}): Promise<CodexIdentity | null> {
  const env = options.env ?? process.env;
  const read =
    options.readFile ??
    (async () => {
      try {
        return await readFile(authPath(env), 'utf8');
      } catch {
        return null;
      }
    });

  const raw = await read();
  return raw ? parseCodexAuth(raw) : null;
}

export function isCodexExpired(identity: CodexIdentity, now = Date.now()): boolean {
  return identity.expiresAt - EXPIRY_BUFFER_MS <= now;
}

/** Re-read on every call, exactly as with Claude Code: the CLI owns this file, not us. */
export class CodexCredential {
  constructor(private readonly options: CodexHarvestOptions = {}) {}

  async status(): Promise<{
    connected: boolean;
    planType: string | null;
    email: string | null;
    accountId: string | null;
    expiresAt: number | null;
    expired: boolean;
  }> {
    const identity = await readCodexLogin(this.options);
    if (!identity) {
      return { connected: false, planType: null, email: null, accountId: null, expiresAt: null, expired: false };
    }
    return {
      connected: true,
      planType: identity.planType,
      email: identity.email,
      accountId: identity.accountId,
      expiresAt: identity.expiresAt || null,
      expired: isCodexExpired(identity, (this.options.now ?? Date.now)()),
    };
  }

  async identity(): Promise<CodexIdentity> {
    const identity = await readCodexLogin(this.options);
    if (!identity) {
      throw new CodexAuthError(
        'No Codex login found on this machine. Run `codex` and sign in with your ChatGPT account, then reload this page.',
        true,
      );
    }
    if (isCodexExpired(identity, (this.options.now ?? Date.now)())) {
      throw new CodexAuthError(
        'The Codex login on this machine has expired. Run `codex` once to refresh it — the CLI keeps its own token current.',
        true,
      );
    }
    return identity;
  }
}
