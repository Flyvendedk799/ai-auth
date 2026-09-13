import { describe, expect, it } from 'vitest';
import {
  exchangeGeminiCode,
  GEMINI_OAUTH,
  GeminiLoginError,
  parseGeminiCallback,
  sameState,
  startGeminiLogin,
} from './oauth.js';

describe('startGeminiLogin', () => {
  it('generates PKCE parameters and authorization URL', () => {
    const login = startGeminiLogin();

    expect(login.verifier).toBeDefined();
    expect(login.verifier.length).toBeGreaterThan(30);
    expect(login.state).toBeDefined();
    expect(login.url).toContain(GEMINI_OAUTH.authorizeUrl);
    expect(login.url).toContain('response_type=code');
    expect(login.url).toContain('code_challenge_method=S256');
    expect(login.url).toContain('access_type=offline');
    expect(login.url).toContain(encodeURIComponent(GEMINI_OAUTH.clientId));
  });

  it('allows overriding redirectUri and scopes', () => {
    const login = startGeminiLogin({
      redirectUri: 'http://localhost:9999/callback',
      scopes: ['custom-scope'],
    });

    expect(login.url).toContain(encodeURIComponent('http://localhost:9999/callback'));
    expect(login.url).toContain('custom-scope');
  });
});

describe('sameState', () => {
  it('matches identical states and rejects mismatches', () => {
    expect(sameState('abc123state', 'abc123state')).toBe(true);
    expect(sameState('abc123state', 'different')).toBe(false);
    expect(sameState('abc123state', '')).toBe(false);
  });
});

describe('parseGeminiCallback', () => {
  it('parses raw code', () => {
    expect(parseGeminiCallback('4/0AY0e-gtest')).toEqual({
      code: '4/0AY0e-gtest',
      state: null,
    });
  });

  it('parses code#state', () => {
    expect(parseGeminiCallback('code123#state456')).toEqual({
      code: 'code123',
      state: 'state456',
    });
  });

  it('parses full redirect URL', () => {
    const url = 'http://localhost:8080/?code=4/0AY0code&state=xyzState';
    expect(parseGeminiCallback(url)).toEqual({
      code: '4/0AY0code',
      state: 'xyzState',
    });
  });

  it('returns null on empty string', () => {
    expect(parseGeminiCallback('')).toBeNull();
    expect(parseGeminiCallback('   ')).toBeNull();
  });
});

describe('exchangeGeminiCode', () => {
  it('exchanges code for tokens and userinfo', async () => {
    const mockFetch = (async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        const body = String(init?.body);
        expect(body).toContain('grant_type=authorization_code');
        expect(body).toContain('code=auth-code');
        expect(body).toContain('code_verifier=my-verifier');

        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'ya29.exchanged-token',
            refresh_token: '1//refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'cloud-platform',
          }),
        } as unknown as Response;
      }

      if (urlStr.includes('googleapis.com/oauth2/v2/userinfo')) {
        expect(init?.headers).toEqual({ Authorization: 'Bearer ya29.exchanged-token' });
        return {
          ok: true,
          status: 200,
          json: async () => ({ email: 'developer@example.com' }),
        } as unknown as Response;
      }

      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as unknown as typeof fetch;

    const result = await exchangeGeminiCode('auth-code', 'my-verifier', {
      fetchImpl: mockFetch,
    });

    expect(result.accessToken).toBe('ya29.exchanged-token');
    expect(result.refreshToken).toBe('1//refresh-token');
    expect(result.email).toBe('developer@example.com');
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it('throws GeminiLoginError on exchange failure', async () => {
    const mockFetch = (async () => {
      return {
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      exchangeGeminiCode('bad-code', 'verifier', { fetchImpl: mockFetch }),
    ).rejects.toThrow(GeminiLoginError);
  });
});
