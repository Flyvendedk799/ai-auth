/**
 * Encryption at rest for anything that can spend money.
 *
 * One primitive, used for both kinds of credential this library stores: a pasted API key and
 * an OAuth refresh token are the same risk wearing different clothes, and giving them
 * different protection would only mean getting one of them wrong.
 *
 * AES-256-GCM, stored as `iv:tag:ciphertext` in hex. GCM rather than CBC so a tampered value
 * fails to decrypt instead of decrypting to garbage that some parser downstream then has to
 * be robust against.
 *
 * The key is derived from a secret the host already has — a session secret, a `SECRET_KEY`,
 * whatever the app is already keeping — rather than introducing a second thing to manage and
 * lose. Each store passes its own `label`, and that separation is load-bearing: a ciphertext
 * written by the API-key store must not decrypt under the OAuth store's key, so that a bug
 * that reads the wrong row fails loudly rather than handing one subsystem another's secret.
 *
 * The honest trade: rotating the host secret makes everything stored unreadable. `open`
 * returns null rather than throwing so that reads through it degrade to "not configured" —
 * the user signs in again, which works — instead of taking the process down at boot.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class SecretBox {
  private readonly key: Buffer;

  /**
   * @param secret  The host's own secret. Anything with real entropy; it is hashed, not used raw.
   * @param label   Namespaces the derived key. Give each store its own and never reuse one.
   */
  constructor(secret: string, label: string) {
    if (!secret) throw new Error('SecretBox needs a non-empty secret');
    if (!label) throw new Error('SecretBox needs a label, so two stores cannot share a key');
    this.key = createHash('sha256').update(`${label}:${secret}`).digest();
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join(':');
  }

  /** Null for anything that will not open: wrong key, tampered value, or simply not ours. */
  open(sealed: string): string | null {
    const parts = sealed.split(':');
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, dataHex] = parts as [string, string, string];
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataHex, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }

  sealJson(value: unknown): string {
    return this.seal(JSON.stringify(value));
  }

  openJson<T>(sealed: string): T | null {
    const plain = this.open(sealed);
    if (plain === null) return null;
    try {
      return JSON.parse(plain) as T;
    } catch {
      return null;
    }
  }
}

/**
 * Enough of a secret to recognise, never enough to use.
 *
 * Shown wherever a UI has to say "there is a key here" without becoming a way to read it back
 * out. The head is kept because it is the part that identifies the *kind* of key — `sk-ant-`,
 * `sk-proj-` — and the tail because it is what someone compares against their own records.
 */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 12) return '••••';
  return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}
