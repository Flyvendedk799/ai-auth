import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  decryptGeminiFile,
  GeminiAuthError,
  GeminiCliCredential,
  isGeminiExpired,
  parseGeminiAuth,
  readGeminiLogin,
  refreshGeminiToken,
  type GeminiIdentity,
} from './localCli.js';

function encryptHelper(text: string, host = hostname(), user = userInfo().username): string {
  const salt = `${host}-${user}-gemini-cli`;
  const key = scryptSync('gemini-cli-oauth', salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc}`;
}

const HOUR = 3_600_000;

describe('parseGeminiAuth', () => {
  it('reads nested FileKeychain structure from gemini-cli', () => {
    const raw = JSON.stringify({
      'gemini-cli-oauth': {
        'main-account': JSON.stringify({
          serverName: 'main-account',
          token: {
            accessToken: 'ya29.live-token-123',
            refreshToken: '1//refresh-token-456',
            expiresAt: 1_800_000_000_000,
            tokenType: 'Bearer',
            scope: 'cloud-platform userinfo.email',
          },
          updatedAt: Date.now(),
        }),
      },
    });

    const parsed = parseGeminiAuth(raw);
    expect(parsed).toEqual({
      accessToken: 'ya29.live-token-123',
      refreshToken: '1//refresh-token-456',
      expiresAt: 1_800_000_000_000,
      email: null,
      projectId: undefined,
      tokenType: 'Bearer',
      scope: 'cloud-platform userinfo.email',
    });
  });

  it('reads encrypted FileKeychain file content', () => {
    const innerJson = JSON.stringify({
      'gemini-cli-oauth': {
        'main-account': JSON.stringify({
          token: {
            accessToken: 'ya29.encrypted-token',
            refreshToken: '1//refresh-encrypted',
            expiresAt: 1_900_000_000_000,
          },
        }),
      },
    });

    const encrypted = encryptHelper(innerJson);
    const parsed = parseGeminiAuth(encrypted);
    expect(parsed?.accessToken).toBe('ya29.encrypted-token');
    expect(parsed?.refreshToken).toBe('1//refresh-encrypted');
    expect(parsed?.expiresAt).toBe(1_900_000_000_000);
  });

  it('reads standard Google Credentials (snake_case)', () => {
    const raw = JSON.stringify({
      access_token: 'ya29.snake-case',
      refresh_token: '1//snake-refresh',
      expiry_date: 1_700_000_000_000,
      token_type: 'Bearer',
    });

    const parsed = parseGeminiAuth(raw);
    expect(parsed?.accessToken).toBe('ya29.snake-case');
    expect(parsed?.refreshToken).toBe('1//snake-refresh');
    expect(parsed?.expiresAt).toBe(1_700_000_000_000);
  });

  it('converts expiry seconds to milliseconds when needed', () => {
    const raw = JSON.stringify({
      access_token: 'ya29.seconds-exp',
      expires_in: 3600,
    });
    const parsed = parseGeminiAuth(raw);
    expect(parsed?.expiresAt).toBe(3_600_000);
  });

  it('returns null on invalid JSON or empty token', () => {
    expect(parseGeminiAuth('not-json-and-not-encrypted')).toBeNull();
    expect(parseGeminiAuth(JSON.stringify({ accessToken: '' }))).toBeNull();
    expect(parseGeminiAuth(JSON.stringify({ otherField: 'foo' }))).toBeNull();
  });
});

describe('decryptGeminiFile', () => {
  it('returns null on corrupted data format', () => {
    expect(decryptGeminiFile('invalid')).toBeNull();
    expect(decryptGeminiFile('a:b:c')).toBeNull();
  });

  it('decrypts valid payload with matching salt', () => {
    const payload = JSON.stringify({ test: 'hello' });
    const encrypted = encryptHelper(payload, 'myhost', 'myuser');
    const decrypted = decryptGeminiFile(encrypted, 'myhost', 'myuser');
    expect(decrypted).toBe(payload);
  });

  it('fails decryption when salt differs', () => {
    const payload = JSON.stringify({ test: 'hello' });
    const encrypted = encryptHelper(payload, 'hostA', 'userA');
    const decrypted = decryptGeminiFile(encrypted, 'hostB', 'userB');
    expect(decrypted).toBeNull();
  });
});

describe('isGeminiExpired', () => {
  const now = 1_000_000;
  const base: GeminiIdentity = {
    accessToken: 'test',
    refreshToken: null,
    expiresAt: now + 300_000,
    email: null,
  };

  it('is false when well in the future', () => {
    expect(isGeminiExpired(base, now)).toBe(false);
  });

  it('is true within the 60s buffer', () => {
    expect(isGeminiExpired({ ...base, expiresAt: now + 30_000 }, now)).toBe(true);
  });

  it('is true when expired or zero', () => {
    expect(isGeminiExpired({ ...base, expiresAt: now - 1 }, now)).toBe(true);
    expect(isGeminiExpired({ ...base, expiresAt: 0 }, now)).toBe(true);
  });
});

describe('readGeminiLogin', () => {
  it('prefers keychain when available', async () => {
    const keychainBlob = JSON.stringify({
      accessToken: 'from-keychain',
      refreshToken: 'rf-keychain',
      expiresAt: 2_000_000,
    });
    const fileBlob = JSON.stringify({
      accessToken: 'from-file',
      refreshToken: 'rf-file',
      expiresAt: 1_000_000,
    });

    const result = await readGeminiLogin({
      readKeychain: async () => keychainBlob,
      readFile: async () => fileBlob,
    });

    expect(result?.accessToken).toBe('from-keychain');
    expect(result?.source).toBe('keychain');
  });

  it('falls back to file when keychain has no login', async () => {
    const fileBlob = JSON.stringify({
      accessToken: 'from-file',
      refreshToken: 'rf-file',
      expiresAt: 1_000_000,
    });

    const result = await readGeminiLogin({
      readKeychain: async () => null,
      readFile: async () => fileBlob,
    });

    expect(result?.accessToken).toBe('from-file');
    expect(result?.source).toBe('file');
  });

  it('returns null when neither keychain nor file has credentials', async () => {
    const result = await readGeminiLogin({
      readKeychain: async () => null,
      readFile: async () => null,
    });

    expect(result).toBeNull();
  });
});

describe('refreshGeminiToken', () => {
  it('posts refresh token and parses response', async () => {
    const mockFetch = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain('oauth2.googleapis.com');
      expect(init?.method).toBe('POST');
      const body = String(init?.body);
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=my-refresh-token');

      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'fresh-token', expires_in: 3600 }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await refreshGeminiToken('my-refresh-token', { fetchImpl: mockFetch });
    expect(result.accessToken).toBe('fresh-token');
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it('throws GeminiAuthError on failure', async () => {
    const mockFetch = (async () => {
      return {
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      refreshGeminiToken('bad-refresh', { fetchImpl: mockFetch }),
    ).rejects.toThrow(GeminiAuthError);
  });
});

describe('GeminiCliCredential', () => {
  it('reports status correctly', async () => {
    const cred = new GeminiCliCredential({
      readKeychain: async () =>
        JSON.stringify({ accessToken: 'a', expiresAt: Date.now() + HOUR, email: 'user@test.com' }),
    });

    const status = await cred.status();
    expect(status.connected).toBe(true);
    expect(status.expired).toBe(false);
    expect(status.email).toBe('user@test.com');
    expect(status.source).toBe('keychain');
  });

  it('throws GeminiAuthError when not logged in', async () => {
    const cred = new GeminiCliCredential({
      readKeychain: async () => null,
      readFile: async () => null,
    });

    await expect(cred.identity()).rejects.toThrow(GeminiAuthError);
  });
});
