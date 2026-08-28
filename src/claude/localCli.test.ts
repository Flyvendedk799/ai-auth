/**
 * The credential parsers.
 *
 * These read files somebody else writes — Claude Code's and the Codex CLI's — which is the
 * whole reason they are worth testing hard. A format we do not control can change under us,
 * and the only defensible behaviour when it does is to return "no login" rather than a
 * half-built credential that fails at the far end of a call with an opaque 401.
 */

import { describe, expect, it } from 'vitest';
import {
  ClaudeCodeCredential,
  isExpired,
  parseClaudeCredentials,
  readClaudeCodeLogin,
  refreshClaudeCodeToken,
  type ClaudeCodeIdentity,
} from './localCli.js';
import {
  accountIdFromToken,
  decodeJwtClaims,
  isCodexExpired,
  parseCodexAuth,
} from '../codex/localCli.js';

/** A JWT with the given claims. Unsigned: nothing here verifies one, and nothing should. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

const HOUR = 3_600_000;

describe('parseClaudeCredentials', () => {
  const blob = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat-live',
        refreshToken: 'sk-ant-ort-live',
        expiresAt: 1_800_000_000_000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        ...over,
      },
    });

  it('reads the shape Claude Code actually writes', () => {
    expect(parseClaudeCredentials(blob(), 'file')).toEqual({
      accessToken: 'sk-ant-oat-live',
      refreshToken: 'sk-ant-ort-live',
      expiresAt: 1_800_000_000_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      source: 'file',
    });
  });

  it('accepts the same fields at the root, which older writes used', () => {
    const flat = JSON.stringify({ accessToken: 'a', refreshToken: 'b', expiresAt: 1 });
    expect(parseClaudeCredentials(flat, 'keychain')?.accessToken).toBe('a');
  });

  it('accepts snake_case, because two spellings of the same file exist in the wild', () => {
    const snake = JSON.stringify({ access_token: 'a', refresh_token: 'b', expires_at: 5 });
    expect(parseClaudeCredentials(snake, 'file')).toMatchObject({
      accessToken: 'a',
      refreshToken: 'b',
      expiresAt: 5,
    });
  });

  it('is null without an access token — a credential with no token is not a credential', () => {
    expect(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { refreshToken: 'b' } }), 'file')).toBeNull();
    expect(parseClaudeCredentials('{}', 'file')).toBeNull();
  });

  it('is null on anything that is not JSON, rather than throwing into a request handler', () => {
    expect(parseClaudeCredentials('not json at all', 'file')).toBeNull();
    expect(parseClaudeCredentials('[1,2,3]', 'file')).toBeNull();
  });

  it('treats a missing expiry as already expired, not as forever', () => {
    // The dangerous direction is assuming a dead token is live: that fails in the middle of a
    // generation instead of before one, where a refresh could still have saved it.
    const parsed = parseClaudeCredentials(blob({ expiresAt: undefined }), 'file');
    expect(parsed?.expiresAt).toBe(0);
    expect(isExpired(parsed as ClaudeCodeIdentity)).toBe(true);
  });

  it('drops non-string scopes rather than passing them through', () => {
    expect(parseClaudeCredentials(blob({ scopes: ['ok', 7, null] }), 'file')?.scopes).toEqual(['ok']);
  });
});

describe('readClaudeCodeLogin', () => {
  const good = JSON.stringify({ claudeAiOauth: { accessToken: 'from-keychain', expiresAt: 9 } });

  it('prefers the keychain, which is the newer of the two stores on a Mac', async () => {
    const identity = await readClaudeCodeLogin({
      readKeychain: async () => good,
      readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } }),
    });
    expect(identity?.accessToken).toBe('from-keychain');
    expect(identity?.source).toBe('keychain');
  });

  it('falls through to the file when the keychain has nothing', async () => {
    const identity = await readClaudeCodeLogin({
      readKeychain: async () => null,
      readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } }),
    });
    expect(identity).toMatchObject({ accessToken: 'from-file', source: 'file' });
  });

  it('falls through when the keychain holds something unparseable, rather than giving up', async () => {
    const identity = await readClaudeCodeLogin({
      readKeychain: async () => 'garbage',
      readFile: async () => good,
    });
    expect(identity?.accessToken).toBe('from-keychain');
  });

  it('is null when neither store has a login', async () => {
    expect(await readClaudeCodeLogin({ readKeychain: async () => null, readFile: async () => null })).toBeNull();
  });
});

describe('refreshClaudeCodeToken', () => {
  const expired: ClaudeCodeIdentity = {
    accessToken: 'old',
    refreshToken: 'refresh-me',
    expiresAt: 0,
    subscriptionType: 'max',
    scopes: [],
    source: 'file',
  };

  it('exchanges the refresh token and dates the new one from the response', async () => {
    const refreshed = await refreshClaudeCodeToken(expired, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), { status: 200 }),
      now: () => 1_000_000,
    });
    expect(refreshed.accessToken).toBe('new');
    expect(refreshed.expiresAt).toBe(1_000_000 + 3600 * 1000);
  });

  it('keeps the old refresh token when the server does not rotate it', async () => {
    const refreshed = await refreshClaudeCodeToken(expired, {
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'new' }), { status: 200 }),
    });
    expect(refreshed.refreshToken).toBe('refresh-me');
  });

  it('takes the rotated refresh token when there is one', async () => {
    const refreshed = await refreshClaudeCodeToken(expired, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rotated' }), { status: 200 }),
    });
    expect(refreshed.refreshToken).toBe('rotated');
  });

  it('asks for a fresh sign-in on a rejected token, and says so', async () => {
    await expect(
      refreshClaudeCodeToken(expired, { fetchImpl: async () => new Response('', { status: 401 }) }),
    ).rejects.toMatchObject({ needsLogin: true });
  });

  it('does not ask for a sign-in when the network is merely down', async () => {
    // A 500 or a dropped connection is not evidence the credential is bad, and telling
    // someone to sign in again over one is how a working setup gets thrown away.
    await expect(
      refreshClaudeCodeToken(expired, { fetchImpl: async () => new Response('', { status: 503 }) }),
    ).rejects.toMatchObject({ needsLogin: false });
  });

  it('refuses without a refresh token instead of posting an empty exchange', async () => {
    await expect(
      refreshClaudeCodeToken({ ...expired, refreshToken: null }, { fetchImpl: async () => new Response('') }),
    ).rejects.toMatchObject({ needsLogin: true });
  });
});

describe('ClaudeCodeCredential', () => {
  const live = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ claudeAiOauth: { accessToken: 'live', expiresAt: Date.now() + HOUR, ...over } });

  it('uses the CLI token while it is live, without touching the network', async () => {
    const credential = new ClaudeCodeCredential({
      readKeychain: async () => null,
      readFile: async () => live(),
    });
    expect(await credential.token()).toBe('live');
  });

  it('re-reads on every call, so a sign-out is noticed immediately', async () => {
    let raw: string | null = live();
    const credential = new ClaudeCodeCredential({ readKeychain: async () => null, readFile: async () => raw });
    expect(await credential.token()).toBe('live');
    raw = null;
    await expect(credential.token()).rejects.toMatchObject({ needsLogin: true });
  });

  it('prefers a newly live CLI token over one it refreshed earlier', async () => {
    // The CLI is the owner of this credential. A token we refreshed must never shadow a
    // re-login the user has since done, or signing in again would appear to do nothing.
    let raw = live({ accessToken: 'stale', expiresAt: 0 });
    const credential = new ClaudeCodeCredential({ readKeychain: async () => null, readFile: async () => raw });
    raw = live({ accessToken: 'signed-in-again' });
    expect(await credential.token()).toBe('signed-in-again');
  });

  it('reports what a status page shows, and never the token', async () => {
    const credential = new ClaudeCodeCredential({
      readKeychain: async () => null,
      readFile: async () => live({ subscriptionType: 'max' }),
    });
    const status = await credential.status();
    expect(status).toMatchObject({ connected: true, subscriptionType: 'max', source: 'file', expired: false });
    expect(JSON.stringify(status)).not.toContain('live');
  });

  it('reports not-connected rather than throwing when there is no login', async () => {
    const credential = new ClaudeCodeCredential({ readKeychain: async () => null, readFile: async () => null });
    expect(await credential.status()).toMatchObject({ connected: false, subscriptionType: null });
  });
});

describe('decodeJwtClaims', () => {
  it('reads the payload without verifying it', () => {
    expect(decodeJwtClaims(jwt({ exp: 42 }))).toEqual({ exp: 42 });
  });

  it('is null on anything that is not a JWT', () => {
    expect(decodeJwtClaims('nope')).toBeNull();
    expect(decodeJwtClaims('a.!!!.c')).toBeNull();
  });
});

describe('accountIdFromToken', () => {
  it('reads the ChatGPT account id from the OpenAI auth claim', () => {
    const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } });
    expect(accountIdFromToken(token)).toBe('acct_1');
  });

  it('falls back to the first organization', () => {
    expect(accountIdFromToken(jwt({ organizations: [{ id: 'org_1' }] }))).toBe('org_1');
  });

  it('is null when the token names no account', () => {
    expect(accountIdFromToken(jwt({ sub: 'user' }))).toBeNull();
  });
});

describe('parseCodexAuth', () => {
  const token = jwt({
    exp: 2_000_000_000,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_9', chatgpt_plan_type: 'pro' },
  });

  it('reads the nested shape the CLI writes', () => {
    const parsed = parseCodexAuth(JSON.stringify({ tokens: { access_token: token, refresh_token: 'r' } }));
    expect(parsed).toMatchObject({
      accessToken: token,
      refreshToken: 'r',
      accountId: 'acct_9',
      planType: 'pro',
      expiresAt: 2_000_000_000_000,
    });
  });

  it('accepts a flat object and camelCase, for the same reason the Claude parser does', () => {
    expect(parseCodexAuth(JSON.stringify({ accessToken: token }))?.accountId).toBe('acct_9');
  });

  it('prefers an explicit account id over one dug out of the token', () => {
    const parsed = parseCodexAuth(JSON.stringify({ tokens: { access_token: token, account_id: 'acct_explicit' } }));
    expect(parsed?.accountId).toBe('acct_explicit');
  });

  it('treats a token with no expiry claim as expired', () => {
    const parsed = parseCodexAuth(JSON.stringify({ tokens: { access_token: jwt({ sub: 'u' }) } }));
    expect(parsed?.expiresAt).toBe(0);
    expect(isCodexExpired(parsed!)).toBe(true);
  });

  it('is null without an access token, and on anything unparseable', () => {
    expect(parseCodexAuth(JSON.stringify({ tokens: { refresh_token: 'r' } }))).toBeNull();
    expect(parseCodexAuth('nope')).toBeNull();
  });
});
