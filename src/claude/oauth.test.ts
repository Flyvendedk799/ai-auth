import { describe, expect, it } from 'vitest';
import {
  CLAUDE_OAUTH,
  exchangeClaudeCode,
  parsePastedCode,
  sameState,
  startClaudeLogin,
} from './oauth.js';

describe('startClaudeLogin', () => {
  it('builds an authorize URL with every parameter the flow needs', () => {
    const started = startClaudeLogin();
    const url = new URL(started.url);

    expect(`${url.origin}${url.pathname}`).toBe(CLAUDE_OAUTH.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH.clientId);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(CLAUDE_OAUTH.redirectUri);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(started.state);
    // `code=true` is what makes the page display a code to copy rather than redirect to a
    // loopback port a server does not have.
    expect(url.searchParams.get('code')).toBe('true');
  });

  it('asks for exactly the scopes a real Claude Code login carries', () => {
    const url = new URL(startClaudeLogin().url);
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([...CLAUDE_OAUTH.scopes].sort());
  });

  it('never puts the verifier in the URL — it is the only thing binding the code to us', () => {
    const started = startClaudeLogin();
    expect(started.url).not.toContain(started.verifier);
    // The challenge is the hash, so it must differ from the verifier itself.
    expect(new URL(started.url).searchParams.get('code_challenge')).not.toBe(started.verifier);
  });

  it('is different every time, or two logins could be crossed', () => {
    const a = startClaudeLogin();
    const b = startClaudeLogin();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe('parsePastedCode', () => {
  it('splits the `code#state` the approval page hands out', () => {
    expect(parsePastedCode('abc123#xyz789')).toEqual({ code: 'abc123', state: 'xyz789' });
  });

  it('survives the whitespace a paste picks up', () => {
    expect(parsePastedCode('  abc123#xyz789 \n')).toEqual({ code: 'abc123', state: 'xyz789' });
    // Wrapped across lines by a terminal or an email client.
    expect(parsePastedCode('abc123#\nxyz789')).toEqual({ code: 'abc123', state: 'xyz789' });
  });

  it('accepts a whole URL, because that is what half of people will paste', () => {
    expect(parsePastedCode('https://platform.claude.com/oauth/code/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    });
  });

  it('accepts a bare code, and reports no state rather than inventing one', () => {
    expect(parsePastedCode('abc123')).toEqual({ code: 'abc123', state: null });
  });

  it('is null on nothing, and on a URL with no code in it', () => {
    expect(parsePastedCode('   ')).toBeNull();
    expect(parsePastedCode('https://platform.claude.com/oauth/code/callback')).toBeNull();
    expect(parsePastedCode('#onlystate')).toBeNull();
  });
});

describe('sameState', () => {
  it('matches an exact state and nothing else', () => {
    expect(sameState('abc', 'abc')).toBe(true);
    expect(sameState('abc', 'abd')).toBe(false);
    // Length differences must not throw out of the constant-time compare.
    expect(sameState('abc', 'abcd')).toBe(false);
    expect(sameState('abc', '')).toBe(false);
  });
});

describe('exchangeClaudeCode', () => {
  const base = { code: 'the-code', state: 'the-state', verifier: 'the-verifier' };

  it('posts the body shape the CLI posts, as JSON', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    await exchangeClaudeCode({
      ...base,
      now: () => 1_000_000,
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init as RequestInit };
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      },
    });

    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe(CLAUDE_OAUTH.tokenUrl);
    // Form-encoding is what most OAuth servers want and is rejected here, so the content type
    // is part of the contract rather than a detail.
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(call.init.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: CLAUDE_OAUTH.redirectUri,
      client_id: CLAUDE_OAUTH.clientId,
      code_verifier: 'the-verifier',
      state: 'the-state',
    });
  });

  it('dates the token from the response', async () => {
    const identity = await exchangeClaudeCode({
      ...base,
      now: () => 5_000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_in: 60 }), {
          status: 200,
        }),
    });
    expect(identity).toMatchObject({ accessToken: 'tok', refreshToken: 'ref', expiresAt: 5_000 + 60_000 });
  });

  it('reads the scopes and plan back when the server sends them', async () => {
    const identity = await exchangeClaudeCode({
      ...base,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            access_token: 'tok',
            scope: 'user:inference user:profile',
            account: { subscription_type: 'max' },
          }),
          { status: 200 },
        ),
    });
    expect(identity.scopes).toEqual(['user:inference', 'user:profile']);
    expect(identity.subscriptionType).toBe('max');
  });

  it('asks for a restart on a rejected code, because a code is single use', async () => {
    await expect(
      exchangeClaudeCode({ ...base, fetchImpl: async () => new Response('', { status: 400 }) }),
    ).rejects.toMatchObject({ restart: true });
  });

  it('does not ask for a restart when the network merely failed', async () => {
    // The code may still be good; throwing the login away over a 503 wastes a working one.
    await expect(
      exchangeClaudeCode({ ...base, fetchImpl: async () => new Response('', { status: 503 }) }),
    ).rejects.toMatchObject({ restart: false });
  });

  it('treats a 200 with no token as a restart rather than storing nothing', async () => {
    await expect(
      exchangeClaudeCode({ ...base, fetchImpl: async () => new Response('{}', { status: 200 }) }),
    ).rejects.toMatchObject({ restart: true });
  });
});
