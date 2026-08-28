/**
 * One account's Claude subscription, stored and kept fresh.
 *
 * The machine-local reader in `localCli.ts` deliberately never refreshes a live token: that
 * credential belongs to the `claude` CLI, and rotating its refresh token would break the CLI's
 * own session. This is the opposite case in every respect. The credential was minted *for*
 * this app by a login the user did here, no CLI is holding a second copy, and nothing else
 * will ever refresh it — so refreshing is not merely safe, it is the only thing keeping the
 * account connected past the first hour.
 *
 * Which means the rotated refresh token has to be written back. A refresh that returns a new
 * refresh token and drops it on the floor works exactly once and then logs the user out for
 * reasons nobody can reconstruct afterwards.
 *
 * Storage is an interface, not a table — see `store/types.ts`. What lands in it is sealed
 * first, so an adapter never holds a token in the clear and writing a new adapter involves no
 * decisions about cryptography.
 */

import { SecretBox } from '../keys/secretBox.js';
import type { CredentialStore } from '../store/types.js';
import { ClaudeCodeAuthError, refreshClaudeCodeToken, type ClaudeCodeIdentity } from './localCli.js';

/** Refresh this far ahead of expiry so a call never races the exchange. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Namespaces the derived key. Never reuse it for another store — see `SecretBox`. */
const SECRET_LABEL = 'ai-auth-claude-oauth';

interface StoredPayload {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
}

export interface ClaudeAccountStatus {
  connected: boolean;
  plan: string | null;
  /** Unix ms, or null when nothing is connected. */
  expiresAt: number | null;
  /** True when the token has aged out. Not a failure — it refreshes on next use. */
  expired: boolean;
  scopes: string[];
}

export interface ClaudeIdentityInput {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string | null;
}

export interface ClaudeAccountStoreOptions {
  store: CredentialStore;
  /** The host's own secret. Hashed with a label, never used raw. */
  secret: string;
  /** Prefixes the store key, so several apps can share one table without colliding. */
  namespace?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DISCONNECTED: ClaudeAccountStatus = {
  connected: false,
  plan: null,
  expiresAt: null,
  expired: false,
  scopes: [],
};

export class ClaudeAccountStore {
  private readonly box: SecretBox;
  private readonly prefix: string;
  private readonly now: () => number;
  /** One in-flight refresh per account, so a burst of calls triggers a single exchange. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly options: ClaudeAccountStoreOptions) {
    this.box = new SecretBox(options.secret, SECRET_LABEL);
    this.prefix = options.namespace ? `${options.namespace}:claude:` : 'claude:';
    this.now = options.now ?? Date.now;
  }

  private key(accountId: string): string {
    return `${this.prefix}${accountId}`;
  }

  async save(accountId: string, identity: ClaudeIdentityInput): Promise<void> {
    await this.options.store.write(this.key(accountId), {
      payload: this.box.sealJson({
        accessToken: identity.accessToken,
        refreshToken: identity.refreshToken,
        scopes: identity.scopes,
      } satisfies StoredPayload),
      // Beside the payload rather than inside it: a status page should not have to decrypt a
      // token to say which plan is connected and when it runs out.
      meta: {
        plan: identity.subscriptionType,
        expiresAt: Math.round(identity.expiresAt),
      },
    });
  }

  async forget(accountId: string): Promise<void> {
    await this.options.store.delete(this.key(accountId));
  }

  async status(accountId: string, now = this.now()): Promise<ClaudeAccountStatus> {
    const record = await this.options.store.read(this.key(accountId));
    if (!record) return DISCONNECTED;

    const payload = this.box.openJson<StoredPayload>(record.payload);
    // A rotated host secret, or a tampered row. Reading it as "not connected" sends the user
    // through the login again, which is a working recovery; throwing would take a page down
    // over a credential that is merely unreadable.
    if (!payload || typeof payload.accessToken !== 'string') return DISCONNECTED;

    const expiresAt = Number(record.meta.expiresAt ?? 0);
    return {
      connected: true,
      plan: typeof record.meta.plan === 'string' ? record.meta.plan : null,
      expiresAt,
      // Reported rather than hidden. It is not a failure — a refresh happens on the next call
      // — but a status line saying "connected" while the token is dead is a status line that
      // will look like a lie the first time something else goes wrong.
      expired: expiresAt - EXPIRY_BUFFER_MS <= now,
      scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
    };
  }

  /**
   * A usable access token for this account, refreshing if it has gone stale.
   *
   * Deduped per account: a page firing three calls at once must not race three refreshes
   * against each other, because the loser of that race is holding a refresh token the winner
   * has already rotated away.
   */
  async token(accountId: string): Promise<string> {
    const existing = this.refreshing.get(accountId);
    if (existing) return existing;

    // Registered synchronously, before the first await. Reading the store first and
    // registering afterwards — which is the obvious way to write this, and the way the code
    // this was extracted from writes it — is a check-then-act across an await, so three
    // simultaneous callers all see an empty map, all start their own exchange, and two of
    // them end up holding a refresh token the third has already rotated away. The window is
    // narrow and the symptom is an intermittent logout, which is the worst combination.
    const work = this.resolveToken(accountId);
    this.refreshing.set(accountId, work);
    try {
      return await work;
    } finally {
      this.refreshing.delete(accountId);
    }
  }

  private async resolveToken(accountId: string): Promise<string> {
    const record = await this.options.store.read(this.key(accountId));
    if (!record) {
      throw new ClaudeCodeAuthError('This account has no Claude subscription connected.', true);
    }

    const payload = this.box.openJson<StoredPayload>(record.payload);
    if (!payload || typeof payload.accessToken !== 'string') {
      throw new ClaudeCodeAuthError(
        'The stored Claude credential could not be read. Connect the subscription again.',
        true,
      );
    }

    const expiresAt = Number(record.meta.expiresAt ?? 0);
    if (expiresAt - EXPIRY_BUFFER_MS > this.now()) return payload.accessToken;

    const plan = typeof record.meta.plan === 'string' ? record.meta.plan : null;
    const identity: ClaudeCodeIdentity = {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken ?? null,
      expiresAt,
      subscriptionType: plan,
      scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
      source: 'file',
    };

    const refreshed = await refreshClaudeCodeToken(identity, {
      now: this.now,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    // Written back before it is handed out: the rotated refresh token is the only one that
    // will work next time, and losing it costs the user a re-login for no visible reason.
    await this.save(accountId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      scopes: refreshed.scopes,
      subscriptionType: refreshed.subscriptionType,
    });
    return refreshed.accessToken;
  }
}
