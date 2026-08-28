/**
 * The per-account store.
 *
 * Two behaviours here are worth more than the rest and are the reason this file is long: the
 * rotated refresh token has to be *written back*, and concurrent callers must not each start
 * their own refresh. Both fail silently in production — the first as a mysterious logout an
 * hour later, the second as an intermittent one — so neither is something to leave to review.
 */

import { describe, expect, it, vi } from 'vitest';
import { ClaudeAccountStore } from './accountStore.js';
import { ClaudeCodeAuthError } from './localCli.js';
import { MemoryCredentialStore } from '../store/types.js';

const HOUR = 3_600_000;

function tokenResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function setup(options: { now?: () => number; fetchImpl?: typeof fetch } = {}) {
  const store = new MemoryCredentialStore();
  const accounts = new ClaudeAccountStore({
    store,
    secret: 'host-secret',
    ...(options.now ? { now: options.now } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { store, accounts };
}

const identity = (over: Partial<Parameters<ClaudeAccountStore['save']>[1]> = {}) => ({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + HOUR,
  scopes: ['user:inference'],
  subscriptionType: 'max',
  ...over,
});

describe('ClaudeAccountStore', () => {
  it('reports not-connected for an account that has never signed in', async () => {
    const { accounts } = setup();
    expect(await accounts.status('u1')).toEqual({
      connected: false,
      plan: null,
      expiresAt: null,
      expired: false,
      scopes: [],
    });
  });

  it('saves and reports a connection without decrypting to do it', async () => {
    const now = Date.now();
    const { accounts } = setup();
    await accounts.save('u1', identity({ expiresAt: now + HOUR }));

    const status = await accounts.status('u1', now);
    expect(status.connected).toBe(true);
    expect(status.plan).toBe('max');
    expect(status.expired).toBe(false);
    expect(status.scopes).toEqual(['user:inference']);
  });

  it('never writes the token in the clear', async () => {
    const { store, accounts } = setup();
    await accounts.save('u1', identity());
    const record = await store.read('claude:u1');
    expect(record!.payload).not.toContain('access-1');
    expect(record!.payload).not.toContain('refresh-1');
    // The plan and the expiry are deliberately outside the sealed blob.
    expect(record!.meta.plan).toBe('max');
  });

  it('says "expired" out loud rather than showing a green light over a dead token', async () => {
    const now = Date.now();
    const { accounts } = setup();
    await accounts.save('u1', identity({ expiresAt: now - 1 }));
    const status = await accounts.status('u1', now);
    expect(status.connected).toBe(true);
    expect(status.expired).toBe(true);
  });

  it('hands back the stored token while it is live, without touching the network', async () => {
    const now = Date.now();
    const fetchImpl = vi.fn();
    const { accounts } = setup({ now: () => now, fetchImpl: fetchImpl as unknown as typeof fetch });
    await accounts.save('u1', identity({ expiresAt: now + HOUR }));

    expect(await accounts.token('u1')).toBe('access-1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and writes the rotated refresh token back', async () => {
    const now = Date.now();
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
    );
    const { store, accounts } = setup({
      now: () => now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await accounts.save('u1', identity({ expiresAt: now - 1 }));

    expect(await accounts.token('u1')).toBe('access-2');

    // The whole point. A rotated refresh token that is not persisted works exactly once, and
    // then logs the user out an hour later for no reason anybody can reconstruct.
    const reread = new ClaudeAccountStore({ store, secret: 'host-secret', now: () => now });
    const saved = await reread.status('u1', now);
    expect(saved.expiresAt).toBe(now + HOUR);
    expect(await reread.token('u1')).toBe('access-2');
  });

  it('runs one exchange for a burst of concurrent callers', async () => {
    const now = Date.now();
    let issued = 0;
    const fetchImpl = vi.fn(async () => {
      issued++;
      // The loser of a race would be holding a refresh token the winner already rotated away.
      return tokenResponse({
        access_token: `access-${issued + 1}`,
        refresh_token: `refresh-${issued + 1}`,
        expires_in: 3600,
      });
    });
    const { accounts } = setup({ now: () => now, fetchImpl: fetchImpl as unknown as typeof fetch });
    await accounts.save('u1', identity({ expiresAt: now - 1 }));

    const tokens = await Promise.all([
      accounts.token('u1'),
      accounts.token('u1'),
      accounts.token('u1'),
    ]);
    expect(issued).toBe(1);
    expect(tokens).toEqual(['access-2', 'access-2', 'access-2']);
  });

  it('refuses with a "connect it again" error when nothing is stored', async () => {
    const { accounts } = setup();
    await expect(accounts.token('nobody')).rejects.toBeInstanceOf(ClaudeCodeAuthError);
  });

  it('treats an unreadable credential as a reconnect, not as a crash', async () => {
    const store = new MemoryCredentialStore();
    const original = new ClaudeAccountStore({ store, secret: 'host-secret' });
    await original.save('u1', identity());

    const rotated = new ClaudeAccountStore({ store, secret: 'rotated-secret' });
    expect((await rotated.status('u1')).connected).toBe(false);
    await expect(rotated.token('u1')).rejects.toThrow(/could not be read/i);
  });

  it('forgets an account completely', async () => {
    const { accounts } = setup();
    await accounts.save('u1', identity());
    await accounts.forget('u1');
    expect((await accounts.status('u1')).connected).toBe(false);
  });

  it('keeps accounts and namespaces apart', async () => {
    const store = new MemoryCredentialStore();
    const app = new ClaudeAccountStore({ store, secret: 's', namespace: 'app-one' });
    const other = new ClaudeAccountStore({ store, secret: 's', namespace: 'app-two' });

    await app.save('u1', identity());
    expect((await app.status('u2')).connected).toBe(false);
    expect((await other.status('u1')).connected).toBe(false);
    expect((await app.status('u1')).connected).toBe(true);
  });
});
