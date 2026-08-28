/**
 * Harvest the Claude Code subscription login that is already on this machine.
 *
 * If `claude` is logged in on the box this process runs on, there is already an OAuth
 * credential sitting there that bills to a *subscription* rather than to a metered API key.
 * It is a real Anthropic credential for the real `api.anthropic.com`, so nothing about the
 * request changes except how it authenticates and who pays.
 *
 * Claude Code stores it two ways depending on host:
 *
 *   - **macOS**: the Keychain, as a generic password under `Claude Code-credentials`.
 *   - **Linux, headless, or a Mac with no keyring**: `~/.claude/.credentials.json`, plaintext.
 *
 * Both hold the same blob, under `claudeAiOauth`.
 *
 * Two rules make this safe to lean on, and both are the opposite of what you would guess:
 *
 * **Re-read, do not own.** The file is Claude Code's, not ours. The CLI refreshes it on its
 * own schedule, so every call re-reads rather than caching a token for the process lifetime —
 * which means a `claude` login, logout or re-auth is picked up without restarting anything.
 *
 * **Refresh only when it is already dead.** Anthropic may rotate the refresh token on
 * exchange, and a rotated token written nowhere would leave the *user's own CLI* holding a
 * credential the server had already spent. So a refresh happens only once the stored access
 * token has actually expired — by which point the CLI has to re-auth regardless — and the
 * result is kept in memory only. A live login is never disturbed.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The macOS Keychain generic-password service Claude Code writes to. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Claude Code's public OAuth client id.
 *
 * Anthropic binds a refresh token to the client that issued it, so a refresh has to present
 * the same id. It is a public identifier, not a secret — the PKCE flow is what protects the
 * exchange — but it is overridable for the day Anthropic issues a new one, because the
 * alternative is a redeploy to fix a token refresh.
 */
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// Read out of the installed CLI rather than guessed. `console.anthropic.com` also answers,
// but this is the host the client itself posts to and the one that will keep working.
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

/** Treat a token as spent this long before it really expires, so a call cannot race it. */
const EXPIRY_BUFFER_MS = 60_000;

export interface ClaudeCodeIdentity {
  accessToken: string;
  refreshToken: string | null;
  /** Unix ms. */
  expiresAt: number;
  /** `max`, `pro`, … — shown so the admin page can say which plan is paying. */
  subscriptionType: string | null;
  scopes: string[];
  /** Which of the two stores it came from, for the "where did this come from" line. */
  source: 'keychain' | 'file';
}

export interface HarvestOptions {
  /** Injected in tests. Returns the raw JSON blob, or null when there is no login. */
  readKeychain?: () => Promise<string | null>;
  readFile?: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}

function credentialsPath(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CREDENTIALS_FILE || join(homedir(), '.claude', '.credentials.json');
}

async function defaultKeychainRead(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // `security` exits 44 for "not found" and 51 for "interaction not allowed". Neither is an
    // error worth surfacing: both mean the same thing to a caller — no login here.
    return null;
  }
}

/**
 * Parse the credentials blob.
 *
 * Exported for its own tests, because the shape is somebody else's and the only honest way to
 * defend against it changing is to fail closed on a shape we do not recognise. A missing
 * access token returns null rather than a half-built identity: "no login" is a state the
 * caller already handles, and a credential with no token in it is not a credential.
 */
export function parseClaudeCredentials(raw: string, source: 'keychain' | 'file'): ClaudeCodeIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  // The blob nests under `claudeAiOauth`; older writes put the same fields at the root.
  const root = parsed as Record<string, unknown>;
  const nested = root.claudeAiOauth;
  const oauth = (typeof nested === 'object' && nested !== null ? nested : root) as Record<string, unknown>;

  const accessToken = oauth.accessToken ?? oauth.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;

  const refreshToken = oauth.refreshToken ?? oauth.refresh_token;
  const expiresAt = oauth.expiresAt ?? oauth.expires_at;
  const subscriptionType = oauth.subscriptionType ?? oauth.subscription_type;
  const scopes = oauth.scopes;

  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : null,
    // An absent expiry is treated as already expired rather than as forever: the refresh path
    // can recover, and a token assumed valid that is not fails mid-generation instead.
    expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : 0,
    subscriptionType: typeof subscriptionType === 'string' ? subscriptionType : null,
    scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [],
    source,
  };
}

/** The login on this machine, or null when `claude` has never been signed in here. */
export async function readClaudeCodeLogin(options: HarvestOptions = {}): Promise<ClaudeCodeIdentity | null> {
  const env = options.env ?? process.env;

  const fromKeychain = await (options.readKeychain ?? defaultKeychainRead)();
  if (fromKeychain) {
    const parsed = parseClaudeCredentials(fromKeychain, 'keychain');
    if (parsed) return parsed;
  }

  const readPlain =
    options.readFile ??
    (async () => {
      try {
        return await readFile(credentialsPath(env), 'utf8');
      } catch {
        return null;
      }
    });

  const raw = await readPlain();
  return raw ? parseClaudeCredentials(raw, 'file') : null;
}

export function isExpired(identity: ClaudeCodeIdentity, now = Date.now()): boolean {
  return identity.expiresAt - EXPIRY_BUFFER_MS <= now;
}

export class ClaudeCodeAuthError extends Error {
  constructor(
    message: string,
    /** True when reconnecting cannot help — the login is simply not there. */
    readonly needsLogin: boolean,
  ) {
    super(message);
    this.name = 'ClaudeCodeAuthError';
  }
}

interface RefreshResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/**
 * Exchange a refresh token for a live access token.
 *
 * Only ever called on an identity that has already expired — see the note at the top of the
 * file about not disturbing a live CLI login.
 */
export async function refreshClaudeCodeToken(
  identity: ClaudeCodeIdentity,
  options: {
    clientId?: string;
    endpoint?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<ClaudeCodeIdentity> {
  if (!identity.refreshToken) {
    throw new ClaudeCodeAuthError(
      'The Claude Code login on this machine has expired and carries no refresh token. Run `claude` and sign in again.',
      true,
    );
  }

  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let response: Response;
  try {
    response = await doFetch(options.endpoint ?? OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: identity.refreshToken,
        client_id: options.clientId ?? process.env.CLAUDE_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID,
      }),
    });
  } catch (error) {
    throw new ClaudeCodeAuthError(
      `Could not reach Anthropic to refresh the Claude Code token: ${(error as Error).message}`,
      false,
    );
  }

  if (response.status === 400 || response.status === 401) {
    // Revoked or already rotated away. Retrying is noise; the user has to sign in again.
    throw new ClaudeCodeAuthError(
      'Anthropic rejected the stored Claude Code refresh token. Run `claude` and sign in again.',
      true,
    );
  }
  if (!response.ok) {
    throw new ClaudeCodeAuthError(`Refreshing the Claude Code token failed with HTTP ${response.status}.`, false);
  }

  const body = (await response.json().catch(() => null)) as RefreshResponse | null;
  const accessToken = body?.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new ClaudeCodeAuthError('Anthropic returned no access token when refreshing.', false);
  }

  const expiresIn = typeof body?.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  const rotated = body?.refresh_token;

  return {
    ...identity,
    accessToken,
    refreshToken: typeof rotated === 'string' && rotated.length > 0 ? rotated : identity.refreshToken,
    expiresAt: now() + expiresIn * 1000,
  };
}

/**
 * A live access token, harvested and refreshed as needed.
 *
 * The in-memory cache is keyed on nothing and holds one identity, because there is one login
 * per machine. It exists only to carry a *refreshed* token between calls — the file is still
 * re-read first every time, so the CLI signing out is noticed immediately rather than after a
 * cache expiry.
 */
export class ClaudeCodeCredential {
  private refreshed: ClaudeCodeIdentity | null = null;

  constructor(private readonly options: HarvestOptions = {}) {}

  /** What the admin page shows: is there a login, whose plan, and is it usable. */
  async status(): Promise<{
    connected: boolean;
    subscriptionType: string | null;
    source: 'keychain' | 'file' | null;
    expiresAt: number | null;
    expired: boolean;
  }> {
    const identity = await readClaudeCodeLogin(this.options);
    if (!identity) {
      return { connected: false, subscriptionType: null, source: null, expiresAt: null, expired: false };
    }
    return {
      connected: true,
      subscriptionType: identity.subscriptionType,
      source: identity.source,
      expiresAt: identity.expiresAt || null,
      // Reported, not hidden: an expired token that can be refreshed still works, and saying
      // "expired" beside a working connection is more honest than a green light that is
      // relying on a refresh nobody mentioned.
      expired: isExpired(identity),
    };
  }

  async token(): Promise<string> {
    const identity = await readClaudeCodeLogin(this.options);
    if (!identity) {
      throw new ClaudeCodeAuthError(
        'No Claude Code login found on this machine. Run `claude` and sign in, then reload this page.',
        true,
      );
    }

    if (!isExpired(identity)) {
      // The CLI's own token is live. Prefer it over anything cached: it is the newest thing
      // that exists, and using it means a refresh we performed earlier cannot shadow a
      // re-login the user has since done.
      this.refreshed = null;
      return identity.accessToken;
    }

    if (this.refreshed && !isExpired(this.refreshed)) return this.refreshed.accessToken;

    this.refreshed = await refreshClaudeCodeToken(identity);
    return this.refreshed.accessToken;
  }
}
