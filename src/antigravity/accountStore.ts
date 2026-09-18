/**
 * One account's Antigravity subscription, stored and kept fresh.
 *
 * Mirrors `ai-auth`'s `ClaudeAccountStore` (same `SecretBox` sealing, same store, same
 * refresh-and-write-back shape) because there is no Antigravity equivalent to import — see
 * `AntigravityOAuth.ts`'s header for why. Two differences from Claude's version:
 *
 *   * Google does not name a plan the way a Claude subscription does, so the account's own
 *     email is what a status page shows instead — the thing worth confirming is *which*
 *     Google account is connected, not a tier name Google never sends back.
 *   * The generation backend Antigravity uses needs a GCP project id when the account's
 *     license requires one (`userDefinedCloudaicompanionProject: true` — see `credentials.ts`).
 *     Nothing in the OAuth exchange reveals one, so it is a value the user types in here, kept
 *     beside the tokens rather than derived from them.
 */

import { SecretBox } from "@flyvendedk799/ai-auth";
import type { CredentialStore } from "@flyvendedk799/ai-auth";
import { refreshAntigravityToken, type AntigravityOAuthIdentity } from "./oauth.js";

/** Refresh this far ahead of expiry so a call never races the exchange. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Namespaces the derived key. Never reuse it for another store — see `SecretBox`. */
const SECRET_LABEL = "doceomenter-Antigravity-oauth";

interface StoredPayload {
  accessToken: string;
  refreshToken: string | null;
}

export interface AntigravityAccountStatus {
  connected: boolean;
  email: string | null;
  /** Unix ms, or null when nothing is connected. */
  expiresAt: number | null;
  /** True when the token has aged out. Not a failure — it refreshes on next use. */
  expired: boolean;
  /** A GCP project id, if the user supplied one. Not every license needs it. */
  projectId: string | null;
}

export interface AntigravityAccountStoreOptions {
  store: CredentialStore;
  /** The host's own secret. Hashed with a label, never used raw. */
  secret: string;
  /** Prefixes the store key, so several apps can share one table without colliding. */
  namespace?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DISCONNECTED: AntigravityAccountStatus = {
  connected: false,
  email: null,
  expiresAt: null,
  expired: false,
  projectId: null,
};

export class AntigravityAccountStore {
  private readonly box: SecretBox;
  private readonly prefix: string;
  private readonly now: () => number;
  /** One in-flight refresh per account, so a burst of calls triggers a single exchange. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly options: AntigravityAccountStoreOptions) {
    this.box = new SecretBox(options.secret, SECRET_LABEL);
    this.prefix = options.namespace ? `${options.namespace}:Antigravity:` : "Antigravity:";
    this.now = options.now ?? Date.now;
  }

  private key(accountId: string): string {
    return `${this.prefix}${accountId}`;
  }

  async save(accountId: string, identity: AntigravityOAuthIdentity, projectId?: string | null): Promise<void> {
    const existing = await this.options.store.read(this.key(accountId));
    const keptProjectId = projectId !== undefined ? projectId : (existing?.meta.projectId as string | null | undefined) ?? null;

    await this.options.store.write(this.key(accountId), {
      payload: this.box.sealJson({
        accessToken: identity.accessToken,
        refreshToken: identity.refreshToken,
      } satisfies StoredPayload),
      // Beside the payload rather than inside it: a status page should not have to decrypt a
      // token to say which account is connected, when it expires, or which project it uses.
      meta: {
        email: identity.email,
        expiresAt: Math.round(identity.expiresAt),
        projectId: keptProjectId,
      },
    });
  }

  /** Change the GCP project id without touching the tokens. */
  async setProjectId(accountId: string, projectId: string | null): Promise<void> {
    const record = await this.options.store.read(this.key(accountId));
    if (!record) return;
    await this.options.store.write(this.key(accountId), {
      payload: record.payload,
      meta: { ...record.meta, projectId: projectId?.trim() || null },
    });
  }

  async forget(accountId: string): Promise<void> {
    await this.options.store.delete(this.key(accountId));
  }

  async status(accountId: string, now = this.now()): Promise<AntigravityAccountStatus> {
    const record = await this.options.store.read(this.key(accountId));
    if (!record) return DISCONNECTED;

    const payload = this.box.openJson<StoredPayload>(record.payload);
    // A rotated host secret, or a tampered row. Reading it as "not connected" sends the user
    // through the login again, which is a working recovery; throwing would take a page down
    // over a credential that is merely unreadable.
    if (!payload || typeof payload.accessToken !== "string") return DISCONNECTED;

    const expiresAt = Number(record.meta.expiresAt ?? 0);
    return {
      connected: true,
      email: typeof record.meta.email === "string" ? record.meta.email : null,
      expiresAt,
      expired: expiresAt - EXPIRY_BUFFER_MS <= now,
      projectId: typeof record.meta.projectId === "string" ? record.meta.projectId : null,
    };
  }

  /**
   * A usable access token for this account, refreshing if it has gone stale.
   *
   * Deduped per account: a page firing three calls at once must not race three refreshes
   * against each other, because the loser of that race is holding a refresh token the winner
   * has already rotated away — Google does not hand back a new one on every refresh, but it
   * can, and a lost rotation reads as an inexplicable sign-out days later.
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
      throw new Error("This account has no Antigravity subscription connected.");
    }

    const payload = this.box.openJson<StoredPayload>(record.payload);
    if (!payload || typeof payload.accessToken !== "string") {
      throw new Error("The stored Antigravity credential could not be read. Connect the subscription again.");
    }

    const expiresAt = Number(record.meta.expiresAt ?? 0);
    if (expiresAt - EXPIRY_BUFFER_MS > this.now()) return payload.accessToken;

    if (!payload.refreshToken) {
      throw new Error("The Antigravity subscription has expired and cannot be refreshed. Connect it again.");
    }

    const refreshed = await refreshAntigravityToken(payload.refreshToken, {
      now: this.now,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    // Written back before it is handed out, same as Claude's store — see that file's note on
    // why losing a rotated refresh token here is a silent, delayed sign-out.
    await this.save(accountId, {
      accessToken: refreshed.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: refreshed.expiresAt,
      email: refreshed.email ?? (typeof record.meta.email === "string" ? record.meta.email : null),
    });
    return refreshed.accessToken;
  }
}

