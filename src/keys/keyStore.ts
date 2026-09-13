/**
 * Bring-your-own API keys, encrypted at rest.
 *
 * Two properties matter, and they are the reason not to keep keys in a plain settings row:
 *
 *   * **Secrets are encrypted.** This holds values that can spend money, and a database dump
 *     is a far more ordinary accident than a compromised host.
 *   * **A secret is never read back out to a caller who only wants to display it.** `hint`
 *     returns a mask built from the plaintext — `sk-ant-…9ZQ` — and there is no path that
 *     hands the whole value to a UI. Only the code about to make a call asks for `key`.
 *
 * Resolution order is settings, then environment, and `source` says which answered. A UI that
 * cannot distinguish "no key" from "a key from the environment" will show an empty field over
 * a working deployment, and the first thing someone does about that is paste a second key in.
 */

import type { CredentialStore } from '../store/types.js';
import { isSubscription, wireOf, type ProviderId } from '../registry/pricing.js';
import { maskSecret, SecretBox } from './secretBox.js';

/** Namespaces the derived key. Never reuse it for another store — see `SecretBox`. */
const SECRET_LABEL = 'ai-auth-api-keys';

export type KeySource = 'stored' | 'environment' | 'subscription' | 'none';

export interface ResolvedKey {
  /** The usable secret, or null when there is none and none is needed. */
  key: string | null;
  source: KeySource;
  /**
   * Whether the selected provider has everything it needs to make a call.
   *
   * One question, because every caller asks the same one and none of them should have to know
   * which kind of provider is selected in order to ask it. A metered provider needs a key; a
   * subscription provider needs a login, which lives elsewhere and is not this store's
   * business — so `ready` is true for those and the caller checks the login separately.
   */
  ready: boolean;
}

export interface ApiKeyStoreOptions {
  store: CredentialStore;
  /** The host's own secret. Hashed with a label, never used raw. */
  secret: string;
  /** Prefixes the store key, so several apps can share one table without colliding. */
  namespace?: string;
  /**
   * Overrides the label the encryption key is derived from.
   *
   * Only ever needed when adopting this library over keys some earlier code already wrote:
   * the label is part of the key, so changing it makes every stored value unreadable. Pass
   * the label the previous code used and nothing has to be re-entered.
   */
  secretLabel?: string;
  /**
   * Where to look when nothing is stored. Defaults to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
   * Pass `{}` to disable the environment fallback entirely.
   */
  env?: Record<string, string | undefined>;
  envNames?: { anthropic?: string; openai?: string; gemini?: string };
}

const DEFAULT_ENV_NAMES = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
} as const;

/** Which wire a provider's key belongs to. Claude Code borrows nothing from an Anthropic key. */
type Wire = 'anthropic' | 'openai' | 'gemini';

export class ApiKeyStore {
  private readonly box: SecretBox;
  private readonly prefix: string;
  private readonly env: Record<string, string | undefined>;
  private readonly envNames: { anthropic: string; openai: string; gemini: string };

  constructor(private readonly options: ApiKeyStoreOptions) {
    this.box = new SecretBox(options.secret, options.secretLabel ?? SECRET_LABEL);
    this.prefix = options.namespace ? `${options.namespace}:key:` : 'key:';
    this.env = options.env ?? process.env;
    this.envNames = {
      anthropic: options.envNames?.anthropic ?? DEFAULT_ENV_NAMES.anthropic,
      openai: options.envNames?.openai ?? DEFAULT_ENV_NAMES.openai,
      gemini: options.envNames?.gemini ?? DEFAULT_ENV_NAMES.gemini,
    };
  }

  private storeKey(wire: Wire): string {
    return `${this.prefix}${wire}`;
  }

  /** Store a key, or clear it by passing null or an empty string. */
  async set(wire: Wire, key: string | null): Promise<void> {
    const trimmed = key?.trim() ?? '';
    if (trimmed.length === 0) {
      await this.options.store.delete(this.storeKey(wire));
      return;
    }
    await this.options.store.write(this.storeKey(wire), {
      payload: this.box.seal(trimmed),
      // The mask lives beside the ciphertext rather than being recomputed on read, so showing
      // a settings page costs no decryption and a rotated host secret still renders.
      meta: { hint: maskSecret(trimmed) },
    });
  }

  /** The stored key in the clear. For the code that is about to make a call, and nothing else. */
  async stored(wire: Wire): Promise<string | null> {
    const record = await this.options.store.read(this.storeKey(wire));
    if (!record) return null;
    return this.box.open(record.payload);
  }

  /** Enough to recognise a key, never enough to use one. Safe to send to a browser. */
  async hint(wire: Wire): Promise<string | null> {
    const record = await this.options.store.read(this.storeKey(wire));
    if (record && typeof record.meta.hint === 'string') return record.meta.hint;

    const fromEnv = this.env[this.envNames[wire]];
    return fromEnv ? maskSecret(fromEnv) : null;
  }

  /**
   * What a caller should use for this provider, and where it came from.
   *
   * Subscription providers resolve to a null key with `source: 'subscription'` — not to
   * "none". Their credential is an OAuth login held elsewhere, and reporting them as unset
   * would put a "configure a key" prompt in front of a deployment that is fully configured.
   */
  async resolve(provider: ProviderId): Promise<ResolvedKey> {
    if (isSubscription(provider)) {
      return { key: null, source: 'subscription', ready: true };
    }

    const wire = wireOf(provider);
    const fromStore = await this.stored(wire);
    if (fromStore) return { key: fromStore, source: 'stored', ready: true };

    const fromEnv = this.env[this.envNames[wire]]?.trim();
    if (fromEnv) return { key: fromEnv, source: 'environment', ready: true };

    return { key: null, source: 'none', ready: false };
  }
}
