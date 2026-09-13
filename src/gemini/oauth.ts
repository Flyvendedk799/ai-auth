/**
 * Signing in to Google with the Gemini CLI client ID.
 *
 * Google uses standard OAuth 2.0 with PKCE:
 *   - authorize: https://accounts.google.com/o/oauth2/v2/auth
 *   - token:     https://oauth2.googleapis.com/token
 *   - userinfo:  https://www.googleapis.com/oauth2/v2/userinfo
 *
 * Scopes requested are the same three `@google/gemini-cli` requests:
 *   - https://www.googleapis.com/auth/cloud-platform
 *   - https://www.googleapis.com/auth/userinfo.email
 *   - https://www.googleapis.com/auth/userinfo.profile
 *
 * Important note on Google OAuth:
 * Google deprecated copy-paste out-of-band (OOB) codes. Authentication must redirect
 * to a registered redirect URI (typically `http://localhost:<port>` or `http://127.0.0.1:<port>`).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  GEMINI_CLI_CLIENT_ID,
  GEMINI_CLI_CLIENT_SECRET,
  GOOGLE_OAUTH_TOKEN_URL,
} from './localCli.js';

export const GEMINI_OAUTH = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
  userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  clientId: GEMINI_CLI_CLIENT_ID,
  clientSecret: GEMINI_CLI_CLIENT_SECRET,
  defaultRedirectUri: 'http://localhost',
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
} as const;

export interface GeminiLoginStart {
  /** The authorization URL where the user approves access. */
  url: string;
  /** Kept secretly on the server to complete the PKCE exchange. */
  verifier: string;
  state: string;
}

export interface GeminiLoginOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: string[];
}

export class GeminiLoginError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'GeminiLoginError';
  }
}

export function startGeminiLogin(options: GeminiLoginOptions = {}): GeminiLoginStart {
  const clientId = options.clientId ?? GEMINI_OAUTH.clientId;
  const redirectUri = options.redirectUri ?? GEMINI_OAUTH.defaultRedirectUri;
  const scopes = options.scopes ?? GEMINI_OAUTH.scopes;

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return {
    url: `${GEMINI_OAUTH.authorizeUrl}?${params.toString()}`,
    verifier,
    state,
  };
}

/**
 * Constant-time comparison for OAuth state strings to avoid timing leaks.
 */
export function sameState(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Parse an authorization code and optional state from either a raw code string
 * or a full redirect callback URL (e.g. `http://localhost:8080/?code=...&state=...`).
 */
export function parseGeminiCallback(raw: string): { code: string; state: string | null } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const code = parsed.searchParams.get('code');
      const state = parsed.searchParams.get('state');
      return code ? { code, state } : null;
    } catch {
      return null;
    }
  }

  // Handle code#state or code&state or raw code
  if (trimmed.includes('#')) {
    const [code, state] = trimmed.split('#');
    return code ? { code, state: state || null } : null;
  }

  return { code: trimmed, state: null };
}

export interface ExchangedGeminiIdentity {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  email: string | null;
  tokenType: string;
  scope?: string;
}

export async function exchangeGeminiCode(
  code: string,
  verifier: string,
  options: GeminiLoginOptions & { fetchImpl?: typeof fetch } = {},
): Promise<ExchangedGeminiIdentity> {
  const clientId = options.clientId ?? GEMINI_OAUTH.clientId;
  const clientSecret = options.clientSecret ?? GEMINI_OAUTH.clientSecret;
  const redirectUri = options.redirectUri ?? GEMINI_OAUTH.defaultRedirectUri;
  const f = options.fetchImpl ?? fetch;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const tokenRes = await f(GEMINI_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new GeminiLoginError(
      `Google OAuth token exchange failed: HTTP ${tokenRes.status} ${text}`,
      tokenRes.status,
    );
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  if (typeof tokenData.access_token !== 'string' || !tokenData.access_token) {
    throw new GeminiLoginError('Google OAuth did not return an access token.');
  }

  const expiresIn = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : 3600;
  const expiresAt = Date.now() + expiresIn * 1000;

  // Attempt to fetch email from userinfo endpoint
  let email: string | null = null;
  try {
    const userRes = await f(GEMINI_OAUTH.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (userRes.ok) {
      const userData = (await userRes.json()) as { email?: string };
      if (typeof userData.email === 'string') {
        email = userData.email;
      }
    }
  } catch {
    // Non-fatal if userinfo fails
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token : null,
    expiresAt,
    email,
    tokenType: tokenData.token_type ?? 'Bearer',
    scope: tokenData.scope,
  };
}
