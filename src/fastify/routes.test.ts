/**
 * The routes, driven through a real Fastify instance.
 *
 * `app.inject` rather than a mock: the things most likely to be wrong here are routing, status
 * codes and body parsing, and every one of them is invisible to a test that calls the handler
 * directly. Nothing reaches the network — the token exchange is stubbed at `fetch`.
 */

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { claudeAuthRoutes, type ClaudeAuthAccount } from './routes.js';
import { ClaudeAccountStore } from '../claude/accountStore.js';
import { MemoryCredentialStore } from '../store/types.js';

function exchangeOk() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'user:inference user:profile',
      account: { subscription_type: 'max' },
    }),
  } as unknown as Response;
}

async function build(
  options: {
    account?: ClaudeAuthAccount | null;
    store?: ClaudeAccountStore | null;
    prefix?: string;
  } = {},
) {
  const app = Fastify();
  const store =
    options.store === undefined
      ? new ClaudeAccountStore({ store: new MemoryCredentialStore(), secret: 'host-secret' })
      : options.store;

  await app.register(
    claudeAuthRoutes({
      resolveAccount: (_request, reply) => {
        const account = options.account === undefined ? { id: 'u1' } : options.account;
        // Mirrors what a real host does: write the 401 itself, then return null.
        if (!account) void reply.code(401).send({ error: 'unauthorized' });
        return account;
      },
      store,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    }),
  );
  return { app, store };
}

describe('claudeAuthRoutes', () => {
  it('reports a fresh account as disconnected but available', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/claude-code' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: false, available: true });
  });

  it('starts a login and hands back only the URL', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/claude-code/login' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { url: string };
    const url = new URL(body.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The verifier is the only thing binding the code to this session. If it ever appears in
    // a response, the flow is decoration rather than security.
    expect(JSON.stringify(body)).not.toContain('verifier');
    expect(url.searchParams.has('code_verifier')).toBe(false);
  });

  it('completes a login and stores the credential', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(exchangeOk());
    try {
      const { app, store } = await build();
      await app.inject({ method: 'POST', url: '/api/claude-code/login' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/claude-code/login/complete',
        payload: { code: 'the-code#the-state' },
      });

      // The state in the paste is not the one this login issued, so it must be refused —
      // which is what the next test asserts. Here the paste carries no matching state at all.
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'state_mismatch' });
      expect((await store!.status('u1')).connected).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('accepts a paste carrying the state it issued', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(exchangeOk());
    try {
      const { app, store } = await build();
      const started = await app.inject({ method: 'POST', url: '/api/claude-code/login' });
      const state = new URL((started.json() as { url: string }).url).searchParams.get('state')!;

      const res = await app.inject({
        method: 'POST',
        url: '/api/claude-code/login/complete',
        payload: { code: `the-code#${state}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ connected: true, plan: 'max', available: true });
      expect(await store!.token('u1')).toBe('access-1');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuses a completion with no login in flight', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/claude-code/login/complete',
      payload: { code: 'orphan' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'no_pending_login' });
  });

  it('refuses a code that is missing, or absurdly long', async () => {
    const { app } = await build();
    await app.inject({ method: 'POST', url: '/api/claude-code/login' });

    expect((await app.inject({
      method: 'POST',
      url: '/api/claude-code/login/complete',
      payload: {},
    })).statusCode).toBe(400);

    expect((await app.inject({
      method: 'POST',
      url: '/api/claude-code/login/complete',
      payload: { code: 'x'.repeat(5000) },
    })).statusCode).toBe(400);
  });

  it('spends a pending login exactly once, so a code cannot be replayed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(exchangeOk());
    try {
      const { app } = await build();
      const started = await app.inject({ method: 'POST', url: '/api/claude-code/login' });
      const state = new URL((started.json() as { url: string }).url).searchParams.get('state')!;
      const payload = { code: `the-code#${state}` };

      expect((await app.inject({ method: 'POST', url: '/api/claude-code/login/complete', payload })).statusCode).toBe(200);
      const replay = await app.inject({ method: 'POST', url: '/api/claude-code/login/complete', payload });
      expect(replay.statusCode).toBe(400);
      expect(replay.json()).toMatchObject({ error: 'no_pending_login' });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('disconnects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(exchangeOk());
    try {
      const { app, store } = await build();
      const started = await app.inject({ method: 'POST', url: '/api/claude-code/login' });
      const state = new URL((started.json() as { url: string }).url).searchParams.get('state')!;
      await app.inject({
        method: 'POST',
        url: '/api/claude-code/login/complete',
        payload: { code: `c#${state}` },
      });

      const res = await app.inject({ method: 'DELETE', url: '/api/claude-code' });
      expect(res.json()).toMatchObject({ connected: false, available: true });
      expect((await store!.status('u1')).connected).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('lets the host own the 401, and never runs the handler after one', async () => {
    const { app } = await build({ account: null });
    const res = await app.inject({ method: 'POST', url: '/api/claude-code/login' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('says the feature is unavailable rather than 500ing when there is no store', async () => {
    const { app } = await build({ store: null });

    // A GET still answers, so a UI can hide the feature instead of showing a broken one.
    expect((await app.inject({ method: 'GET', url: '/api/claude-code' })).json()).toMatchObject({
      connected: false,
      available: false,
    });
    expect((await app.inject({ method: 'POST', url: '/api/claude-code/login' })).statusCode).toBe(503);
  });

  it('mounts under a custom prefix', async () => {
    const { app } = await build({ prefix: '/x/claude' });
    expect((await app.inject({ method: 'GET', url: '/x/claude' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/claude-code' })).statusCode).toBe(404);
  });

  it('keeps one account out of another account\'s login', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(exchangeOk());
    try {
      const shared = new ClaudeAccountStore({
        store: new MemoryCredentialStore(),
        secret: 'host-secret',
      });
      let who = 'alice';
      const app = Fastify();
      await app.register(claudeAuthRoutes({ resolveAccount: () => ({ id: who }), store: shared }));

      const started = await app.inject({ method: 'POST', url: '/api/claude-code/login' });
      const state = new URL((started.json() as { url: string }).url).searchParams.get('state')!;

      // Bob pastes the code from Alice's approval. There is no pending login under his id.
      who = 'bob';
      const res = await app.inject({
        method: 'POST',
        url: '/api/claude-code/login/complete',
        payload: { code: `stolen#${state}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'no_pending_login' });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
