import { describe, expect, it } from 'vitest';
import { MemoryCredentialStore } from '../store/types.js';
import { GeminiAccountStore } from './accountStore.js';
import { GeminiAuthError } from './localCli.js';

const HOUR = 3_600_000;
const SECRET = 'test-secret-key-at-least-32-chars-long';

describe('GeminiAccountStore', () => {
  it('saves and reads account status', async () => {
    const store = new MemoryCredentialStore();
    const accounts = new GeminiAccountStore({ store, secret: SECRET });

    await accounts.save('user-1', {
      accessToken: 'ya29.initial',
      refreshToken: '1//refresh',
      expiresAt: Date.now() + HOUR,
      email: 'tester@example.com',
      projectId: 'my-project-123',
    });

    const status = await accounts.status('user-1');
    expect(status.connected).toBe(true);
    expect(status.expired).toBe(false);
    expect(status.email).toBe('tester@example.com');
    expect(status.projectId).toBe('my-project-123');

    const token = await accounts.token('user-1');
    expect(token).toBe('ya29.initial');
  });

  it('reports disconnected for nonexistent account', async () => {
    const store = new MemoryCredentialStore();
    const accounts = new GeminiAccountStore({ store, secret: SECRET });

    const status = await accounts.status('unknown');
    expect(status.connected).toBe(false);
    expect(status.email).toBeNull();
  });

  it('deletes an account with forget()', async () => {
    const store = new MemoryCredentialStore();
    const accounts = new GeminiAccountStore({ store, secret: SECRET });

    await accounts.save('user-1', {
      accessToken: 'ya29.initial',
      refreshToken: null,
      expiresAt: Date.now() + HOUR,
    });

    await accounts.forget('user-1');
    const status = await accounts.status('user-1');
    expect(status.connected).toBe(false);
  });

  it('refreshes token when near expiration and writes back', async () => {
    const store = new MemoryCredentialStore();

    const mockFetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'ya29.refreshed',
          expires_in: 3600,
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const accounts = new GeminiAccountStore({
      store,
      secret: SECRET,
      fetchImpl: mockFetch,
    });

    // Token expiring in 1 minute (within the 5-min buffer)
    await accounts.save('user-1', {
      accessToken: 'ya29.old',
      refreshToken: '1//refresh',
      expiresAt: Date.now() + 60_000,
      email: 'user@example.com',
    });

    const token = await accounts.token('user-1');
    expect(token).toBe('ya29.refreshed');

    const status = await accounts.status('user-1');
    expect(status.expired).toBe(false);
    expect(status.email).toBe('user@example.com');
  });

  it('throws GeminiAuthError if refresh fails without refresh token', async () => {
    const store = new MemoryCredentialStore();
    const accounts = new GeminiAccountStore({ store, secret: SECRET });

    await accounts.save('user-1', {
      accessToken: 'ya29.old',
      refreshToken: null,
      expiresAt: Date.now() - 10_000,
    });

    await expect(accounts.token('user-1')).rejects.toThrow(GeminiAuthError);
  });
});
