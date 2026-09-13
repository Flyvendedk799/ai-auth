/**
 * One account's Gemini CLI / Google subscription, stored and kept fresh.
 *
 * Like `ClaudeAccountStore`:
 * - Tokens minted for this application are stored encrypted via `SecretBox`.
 * - When an access token expires, it is refreshed via Google's token endpoint and the
 *   rotated refresh token is saved back to storage.
 * - In-flight refreshes are deduplicated per account so concurrent calls don't race.
 */

import { SecretBox } from '../keys/secretBox.js';
import type { CredentialStore } from '../store/types.js';
import { GeminiAuthError, refreshGeminiToken } from './localCli.js';

/** Refresh 5 minutes ahead of expiry so a call never races the exchange. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Namespaces the derived encryption key. */
const SECRET_LABEL = 'ai-auth-gemini-oauth';

interface StoredPayload {
  accessToken: string;
  refreshToken: string | null;
  scope?: string;
}

export interface GeminiAccountStatus {
  connected: boolean;
  email: string | null;
  projectId: string | null;
  expiresAt: number | null;
  expired: boolean;
  scope?: string;
}

export interface GeminiIdentityInput {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  email?: string | null;
  projectId?: string | null;
  scope?: string;
}

export interface GeminiAccountStoreOptions {
  store: CredentialStore;
  secret: string;
  namespace?: string;
  secretLabel?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DISCONNECTED: GeminiAccountStatus = {
  connected: false,
  email: null,
  projectId: null,
  expiresAt: null,
  expired: false,
};

export class GeminiAccountStore {
  private readonly box: SecretBox;
  private readonly prefix: string;
  private readonly now: () => number;
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly options: GeminiAccountStoreOptions) {
    this.box = new SecretBox(options.secret, options.secretLabel ?? SECRET_LABEL);
    this.prefix = options.namespace ? `${options.namespace}:gemini:` : 'gemini:';
    this.now = options.now ?? Date.now;
  }

  private key(accountId: string): string {
    return `${this.prefix}${accountId}`;
  }

  async save(accountId: string, identity: GeminiIdentityInput): Promise<void> {
    await this.options.store.write(this.key(accountId), {
      payload: this.box.sealJson({
        accessToken: identity.accessToken,
        refreshToken: identity.refreshToken,
        scope: identity.scope,
      } satisfies StoredPayload),
      meta: {
        email: identity.email ?? null,
        projectId: identity.projectId ?? null,
        expiresAt: Math.round(identity.expiresAt),
      },
    });
  }

  async forget(accountId: string): Promise<void> {
    await this.options.store.delete(this.key(accountId));
  }

  async status(accountId: string, now = this.now()): Promise<GeminiAccountStatus> {
    const record = await this.options.store.read(this.key(accountId));
    if (!record) return DISCONNECTED;

    const payload = this.box.openJson<StoredPayload>(record.payload);
    if (!payload || typeof payload.accessToken !== 'string') return DISCONNECTED;

    const expiresAt = Number(record.meta.expiresAt ?? 0);
    return {
      connected: true,
      email: typeof record.meta.email === 'string' ? record.meta.email : null,
      projectId: typeof record.meta.projectId === 'string' ? record.meta.projectId : null,
      expiresAt,
      expired: expiresAt - EXPIRY_BUFFER_MS <= now,
      scope: payload.scope,
    };
  }

  /**
   * A usable access token for this account, refreshing if it has gone stale.
   */
  async token(accountId: string): Promise<string> {
    const existing = this.refreshing.get(accountId);
    if (existing) return existing;

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
      throw new GeminiAuthError('This account has no Gemini / Google login connected.', true);
    }

    const payload = this.box.openJson<StoredPayload>(record.payload);
    if (!payload || typeof payload.accessToken !== 'string') {
      throw new GeminiAuthError(
        'The stored Gemini credential could not be read. Connect the account again.',
        true,
      );
    }

    const expiresAt = Number(record.meta.expiresAt ?? 0);
    if (expiresAt - EXPIRY_BUFFER_MS > this.now()) return payload.accessToken;

    if (!payload.refreshToken) {
      throw new GeminiAuthError(
        'The stored Gemini login has expired and has no refresh token. Sign in again.',
        true,
      );
    }

    const refreshed = await refreshGeminiToken(payload.refreshToken, {
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    const email = typeof record.meta.email === 'string' ? record.meta.email : null;
    const projectId = typeof record.meta.projectId === 'string' ? record.meta.projectId : null;

    await this.save(accountId, {
      accessToken: refreshed.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: refreshed.expiresAt,
      email,
      projectId,
      scope: payload.scope,
    });

    return refreshed.accessToken;
  }
}
