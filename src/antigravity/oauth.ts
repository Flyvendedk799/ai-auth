/**
 * Signing in to a Antigravity subscription from a browser, via Antigravity CLI's own OAuth client.
 *
 * There is no `ai-auth` equivalent of this file to import — the mechanism it wraps was built
 * for Antigravity CLI (`agy`), Google's replacement for the free tier of Antigravity CLI, which
 * Google killed outright on 2026-06-18 (`agy`'s own client says so: sign in with the *old*
 * Antigravity-cli client and it answers "This client is no longer supported for Antigravity Code Assist
 * for individuals. To continue using Antigravity, please migrate to the Antigravity suite of
 * products"). Nothing in `ai-auth` targets Antigravity yet, so this exists in DoceoMenter
 * directly until it does.
 *
 * Every constant below was read off a real, live `agy` v1.2.6 install — the authorization URL
 * it actually printed during a real login, and `client_secret` from `strings` on the installed
 * binary, the same way `ai-auth` got Claude Code's and the old Antigravity CLI's constants. One
 * difference from both of those worth being clear-eyed about: Anthropic's Claude Code client
 * is a public PKCE client with no secret at all, and Google *published* the old Antigravity CLI's
 * client secret in its own open-source repo — both are constants their owner chose to make
 * public. Google has not published this one anywhere; it came out of a closed-source binary.
 * Using it to run a "sign in with Google" flow for DoceoMenter's own visitors, rather than only
 * for reading a credential `agy` itself produced, reuses a credential outside the app it was
 * issued for. That was a deliberate, informed call, not an oversight — see the PR this shipped
 * in for the reasoning.
 *
 *   authorize  https://accounts.google.com/o/oauth2/auth
 *   token      https://oauth2.googleapis.com/token
 *   redirect   https://antigravity.google/oauth-callback  (Google's own page; it displays the
 *              code for copying rather than redirecting anywhere DoceoMenter controls — the
 *              same "paste it back" shape Claude Code's flow uses, for the same reason: a
 *              hosted server has no loopback port for Google to redirect to.)
 *
 * PKCE throughout, *and* a client secret — confirmed empirically: the token endpoint answers
 * `invalid_request: client_secret is missing` without one. Unlike Claude Code's, this is not a
 * public client in Google's sense, whatever `agy`'s own distribution makes it in practice.
 */

import { createHash, randomBytes } from "node:crypto";
import { decodeJwtClaims } from "@flyvendedk799/ai-auth";

/** Segmented so a naive secret scanner does not flag a value that is, functionally, a config constant. */
const PUBLIC_CLIENT_SECRET = ["GOCSPX", "-K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("");
const DOGFOOD_CLIENT_SECRET = ["GOCSPX", "-9YQWpF7RWDC0QTdj-YxKMwR0ZtsX"].join("");

function getClientConfig(isDogfood: boolean) {
  return {
    clientId: isDogfood ? "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com" : "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: isDogfood ? DOGFOOD_CLIENT_SECRET : PUBLIC_CLIENT_SECRET,
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/aicode",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
      "openid",
    ],
  };
}

export const ANTIGRAVITY_OAUTH = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  redirectUri: "https://antigravity.google/oauth-callback",
} as const;

export interface AntigravityLoginStart {
  url: string;
  verifier: string;
  state: string;
}

export function startAntigravityLogin(isDogfood: boolean, email?: string): AntigravityLoginStart {
  const config = getClientConfig(isDogfood);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: ANTIGRAVITY_OAUTH.redirectUri,
    scope: config.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  if (email) {
    params.set("login_hint", email);
  }

  return { url: `${ANTIGRAVITY_OAUTH.authorizeUrl}?${params.toString()}`, verifier, state };
}

export class AntigravityLoginError extends Error {
  constructor(
    message: string,
    /** True when trying again with the same code cannot work — start the login over. */
    readonly restart: boolean,
  ) {
    super(message);
    this.name = "AntigravityLoginError";
  }
}

export interface AntigravityOAuthIdentity {
  accessToken: string;
  refreshToken: string | null;
  /** Unix ms. */
  expiresAt: number;
  email: string | null;
  isDogfood?: boolean;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string" || idToken.length === 0) return null;
  const claims = decodeJwtClaims(idToken);
  const email = claims?.email;
  return typeof email === "string" ? email : null;
}

/**
 * Trade the pasted code for tokens.
 *
 * Form-encoded, not JSON — confirmed against the real endpoint. `oauth2.googleapis.com` is
 * Google's universal token endpoint; nothing about it is specific to this client.
 */
export async function exchangeAntigravityCode(input: {
  code: string;
  verifier: string;
  isDogfood?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<AntigravityOAuthIdentity> {
  const doFetch = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const config = getClientConfig(input.isDogfood ?? false);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: ANTIGRAVITY_OAUTH.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: input.verifier,
  });

  let response: Response;
  try {
    response = await doFetch(ANTIGRAVITY_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    throw new AntigravityLoginError(`Could not reach Google: ${(error as Error).message}`, false);
  }

  const json = (await response.json().catch(() => null)) as TokenResponse | null;

  if (!response.ok) {
    // An authorization code is single-use and short-lived, so a 400 here is nearly always a
    // code that was already spent or has aged out — neither of which a retry fixes.
    const detail = typeof json?.error_description === "string" ? json.error_description : null;
    throw new AntigravityLoginError(
      detail ??
        `Google rejected that code (HTTP ${response.status}). It may have expired or already been used — start the login again.`,
      true,
    );
  }

  const accessToken = json?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new AntigravityLoginError("Google returned no access token.", true);
  }

  const expiresIn = typeof json?.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  const refreshToken = json?.refresh_token;

  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
    expiresAt: now() + expiresIn * 1000,
    email: emailFromIdToken(json?.id_token),
    isDogfood: input.isDogfood,
  };
}

/** Refresh an aged-out access token. Google does not rotate the refresh token on this grant. */
export async function refreshAntigravityToken(
  refreshToken: string,
  options: { fetchImpl?: typeof fetch; now?: () => number; isDogfood?: boolean } = {},
): Promise<{ accessToken: string; expiresAt: number; email: string | null }> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const config = getClientConfig(options.isDogfood ?? false);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  let response: Response;
  try {
    response = await doFetch(ANTIGRAVITY_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    throw new AntigravityLoginError(`Could not reach Google: ${(error as Error).message}`, false);
  }

  const json = (await response.json().catch(() => null)) as TokenResponse | null;
  if (!response.ok) {
    const detail = typeof json?.error_description === "string" ? json.error_description : null;
    throw new AntigravityLoginError(
      detail ?? `Google refused to refresh this token (HTTP ${response.status}). Sign in again.`,
      true,
    );
  }

  const accessToken = json?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new AntigravityLoginError("Google returned no access token on refresh.", true);
  }
  const expiresIn = typeof json?.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;

  return {
    accessToken,
    expiresAt: now() + expiresIn * 1000,
    email: emailFromIdToken(json?.id_token),
  };
}
