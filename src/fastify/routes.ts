/**
 * The four routes behind the browser login.
 *
 *   POST   {prefix}/login            begin — returns the URL to approve at
 *   POST   {prefix}/login/complete   finish — takes the pasted code
 *   GET    {prefix}                  is this account connected, and to what
 *   DELETE {prefix}                  disconnect
 *
 * Authentication is a function you supply. The original of this file called into one app's
 * session module, which is exactly the sort of coupling that stops code being reusable: every
 * project has a different idea of what a signed-in user is, and none of them is this
 * library's business. `resolveAccount` gets the request and returns an id, or null to mean
 * "already handled" — so a plugin that wants to send its own 401 can, and one that wants to
 * fall back to a single-user id can do that instead.
 *
 * Who may call these: anyone signed in, not just an administrator. That distinction is the
 * whole point of the per-account flow. Which provider a deployment uses is an operator
 * decision; *whose plan pays* is the user's own, and a per-user credential only an admin could
 * install would be neither.
 *
 * The pending login — the PKCE verifier and the state — is held in memory, keyed by account,
 * for a few minutes. Not in the store, deliberately: it is worthless after the exchange and
 * dangerous before it, so the shortest possible life is the right one. A restart mid-login
 * costing someone one click is a better trade than persisting the one secret that makes a
 * stolen authorization code useful.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ClaudeAccountStore } from '../claude/accountStore.js';
import {
  ClaudeLoginError,
  exchangeClaudeCode,
  parsePastedCode,
  sameState,
  startClaudeLogin,
} from '../claude/oauth.js';

/** How long a started login stays valid. Long enough to read a consent screen, not much more. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** A pasted code is short. This is generous enough for a whole URL and nothing more. */
const MAX_CODE_LENGTH = 2048;

interface Pending {
  verifier: string;
  state: string;
  expiresAt: number;
  isDogfood?: boolean;
}

export interface ClaudeAuthAccount {
  /** Stable per user. Whatever the host calls a user id. */
  id: string;
  /** Logged, never stored. Omit it if you would rather not have it in your logs. */
  label?: string;
}

export interface ClaudeAuthRoutesOptions {
  /**
   * Who is asking. Return null when the request is not authenticated *and* you have already
   * written a response — the route then returns without touching the reply again.
   */
  resolveAccount: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<ClaudeAuthAccount | null> | ClaudeAuthAccount | null;
  /**
   * Null when this deployment has nowhere to keep a credential. The routes then answer
   * honestly — `available: false` — rather than 500ing, so a UI can hide the feature instead
   * of showing one that cannot work.
   */
  store: ClaudeAccountStore | null;
  /** Defaults to `/api/claude-code`. */
  prefix?: string;
  now?: () => number;
}

const DISCONNECTED = {
  connected: false,
  plan: null,
  expiresAt: null,
  expired: false,
  scopes: [] as string[],
};

export function claudeAuthRoutes(options: ClaudeAuthRoutesOptions): FastifyPluginAsync {
  const now = options.now ?? Date.now;
  const prefix = options.prefix ?? '/api/claude-code';
  const pending = new Map<string, Pending>();

  /** Drop anything past its window. Called on each use, so no timer has to exist. */
  const sweep = () => {
    const at = now();
    for (const [key, entry] of pending) if (entry.expiresAt <= at) pending.delete(key);
  };

  return async (app) => {
    app.post(`${prefix}/login`, async (request, reply) => {
      const account = await options.resolveAccount(request, reply);
      if (!account) return;
      if (!options.store) {
        return reply.code(503).send({
          error: 'no_store',
          message: 'Connecting a subscription needs a credential store, and none is configured.',
        });
      }

      sweep();
      const started = startClaudeLogin();
      pending.set(account.id, {
        verifier: started.verifier,
        state: started.state,
        expiresAt: now() + PENDING_TTL_MS,
      });

      request.log?.info({ by: account.label }, 'claude subscription login started');
      // The verifier stays here. Only the URL crosses to the browser.
      return { url: started.url, expiresInSeconds: Math.round(PENDING_TTL_MS / 1000) };
    });

    app.post(`${prefix}/login/complete`, async (request, reply) => {
      const account = await options.resolveAccount(request, reply);
      if (!account) return;
      if (!options.store) return reply.code(503).send({ error: 'no_store' });

      sweep();
      const entry = pending.get(account.id);
      if (!entry) {
        return reply.code(400).send({
          error: 'no_pending_login',
          message: 'That login has expired or was never started. Run the command again.',
        });
      }

      const body = (request.body ?? {}) as { code?: unknown };
      if (typeof body.code !== 'string' || body.code.length > MAX_CODE_LENGTH) {
        return reply
          .code(400)
          .send({ error: 'bad_code', message: 'Paste the code from the approval page.' });
      }

      const parsed = parsePastedCode(body.code);
      if (!parsed) {
        return reply
          .code(400)
          .send({ error: 'bad_code', message: 'That does not look like an authorization code.' });
      }

      // The state binds this code to the login *this* account started. A code obtained in
      // somebody else's approval, pasted here, has to be refused — that is the entire job of
      // the parameter, and skipping the check because the code "looks right" is how it is lost.
      if (parsed.state !== null && !sameState(entry.state, parsed.state)) {
        return reply.code(400).send({
          error: 'state_mismatch',
          message: 'That code came from a different login. Start again and use the newest link.',
        });
      }

      // Single use either way: a code that failed to exchange cannot be retried, and one that
      // succeeded must not be replayed.
      pending.delete(account.id);

      try {
        const identity = await exchangeClaudeCode({
          code: parsed.code,
          state: entry.state,
          verifier: entry.verifier,
        });
        await options.store.save(account.id, identity);
        request.log?.info(
          { by: account.label, plan: identity.subscriptionType },
          'claude subscription connected',
        );
        return { ...(await options.store.status(account.id, now())), available: true };
      } catch (error) {
        if (error instanceof ClaudeLoginError) {
          return reply
            .code(400)
            .send({ error: 'exchange_failed', message: error.message, restart: error.restart });
        }
        throw error;
      }
    });

    app.get(prefix, async (request, reply) => {
      const account = await options.resolveAccount(request, reply);
      if (!account) return;
      if (!options.store) return { ...DISCONNECTED, available: false };
      return { ...(await options.store.status(account.id, now())), available: true };
    });

    app.delete(prefix, async (request, reply) => {
      const account = await options.resolveAccount(request, reply);
      if (!account) return;
      if (!options.store) return reply.code(503).send({ error: 'no_store' });
      pending.delete(account.id);
      await options.store.forget(account.id);
      request.log?.info({ by: account.label }, 'claude subscription disconnected');
      return { ...DISCONNECTED, available: true };
    });
  };
}

import type { AntigravityAccountStore } from '../antigravity/accountStore.js';
import {
  AntigravityLoginError,
  exchangeAntigravityCode,
  startAntigravityLogin,
} from '../antigravity/oauth.js';

export interface AntigravityAuthRoutesOptions {
  resolveAccount: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<ClaudeAuthAccount | null> | ClaudeAuthAccount | null;
  store: AntigravityAccountStore | null;
  prefix?: string;
  now?: () => number;
}

export function antigravityAuthRoutes(options: AntigravityAuthRoutesOptions): FastifyPluginAsync {
  const now = options.now ?? Date.now;
  const prefix = options.prefix ?? '/api/antigravity';
  const pending = new Map<string, Pending>();

  const sweep = () => {
    const at = now();
    for (const [key, entry] of pending) if (entry.expiresAt <= at) pending.delete(key);
  };

  return async (app) => {
    app.post(`${prefix}/login`, async (request, reply) => {
      const body = request.body as { isDogfood?: boolean } | null;
      const isDogfood = typeof body?.isDogfood === 'boolean' ? body.isDogfood : true;
      const account = await options.resolveAccount(request, reply);
      if (!account) return;
      if (!options.store) {
        return reply.code(503).send({
          error: 'no_store',
          message: 'Connecting a subscription needs a credential store, and none is configured.',
        });
      }

      sweep();
      const started = startAntigravityLogin(isDogfood);
      pending.set(account.id, {
        verifier: started.verifier,
        state: started.state,
        expiresAt: now() + PENDING_TTL_MS,
        isDogfood,
      });

      request.log?.info({ by: account.label }, 'antigravity subscription login started');
      return { url: started.url, expiresInSeconds: Math.round(PENDING_TTL_MS / 1000) };
    });

    app.post(`${prefix}/login/complete`, async (request, reply) => {
      const account = await options.resolveAccount(request, reply);
      if (!account) return;
      if (!options.store) return reply.code(503).send({ error: 'no_store' });

      sweep();
      const entry = pending.get(account.id);
      if (!entry) {
        return reply.code(400).send({
          error: 'no_pending_login',
          message: 'That login has expired or was never started. Run the command again.',
        });
      }

      const body = (request.body ?? {}) as { code?: unknown };
      if (typeof body.code !== 'string' || body.code.length > MAX_CODE_LENGTH) {
        return reply
          .code(400)
          .send({ error: 'bad_code', message: 'Paste the code from the approval page.' });
      }

      const parsed = parsePastedCode(body.code);
      if (!parsed) {
        return reply
          .code(400)
          .send({ error: 'bad_code', message: 'That does not look like an authorization code.' });
      }

      if (parsed.state !== null && !sameState(entry.state, parsed.state)) {
        return reply.code(400).send({
          error: 'state_mismatch',
          message: 'That code came from a different login. Start again and use the newest link.',
        });
      }

      pending.delete(account.id);

      try {
        const identity = await exchangeAntigravityCode({
          code: parsed.code,
          verifier: entry.verifier,
          isDogfood: entry.isDogfood,
        });
        await options.store.save(account.id, identity);
        request.log?.info(
          { by: account.label, plan: identity.email },
          'antigravity subscription connected',
        );
        return { ...(await options.store.status(account.id, now())), available: true };
      } catch (error) {
        if (error instanceof AntigravityLoginError) {
          return reply
            .code(400)
            .send({ error: 'exchange_failed', message: error.message, restart: error.restart });
        }
        throw error;
      }
    });

    app.get(prefix, async (request, reply) => {
      const account = await options.resolveAccount(request, reply);
      if (!account) return;
      if (!options.store) return { ...DISCONNECTED, available: false };
      return { ...(await options.store.status(account.id, now())), available: true };
    });

    app.delete(prefix, async (request, reply) => {
      const account = await options.resolveAccount(request, reply);
      if (!account) return;
      if (!options.store) return reply.code(503).send({ error: 'no_store' });
      pending.delete(account.id);
      await options.store.forget(account.id);
      request.log?.info({ by: account.label }, 'antigravity subscription disconnected');
      return { ...DISCONNECTED, available: true };
    });

    app.put(prefix, async (request, reply) => {
      const account = await options.resolveAccount(request, reply);
      if (!account) return;
      if (!options.store) return reply.code(503).send({ error: 'no_store' });
      
      const body = (request.body ?? {}) as { projectId?: unknown };
      const projectId = typeof body.projectId === 'string' ? body.projectId.trim() || null : null;
      
      if (typeof options.store.setProjectId === 'function') {
        await options.store.setProjectId(account.id, projectId);
      }
      return { ...(await options.store.status(account.id, now())), available: true };
    });
  };
}
