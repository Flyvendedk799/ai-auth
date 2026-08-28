/**
 * Where credentials live, as an interface rather than a table.
 *
 * The version of this code that these modules were extracted from spoke SQL directly, which
 * is the right shape for exactly one application and the wrong shape for a library: the next
 * project along has SQLite, or Redis, or a JSON file, or no persistence at all because it is
 * a CLI that runs once. None of that changes what a credential store has to *do*.
 *
 * So it does three things. Two of them are a map.
 *
 * Values are opaque strings — already sealed by the caller before they arrive here. That is
 * deliberate: an adapter cannot leak a plaintext token it was never given, and writing a new
 * adapter therefore involves no decisions about cryptography at all.
 */

export interface StoredRecord {
  /** The sealed payload. Opaque to the store. */
  payload: string;
  /**
   * Small, non-secret facts worth indexing or displaying without opening the payload:
   * the plan name, the expiry. Kept separate so a status page costs no decryption.
   */
  meta: Record<string, string | number | null>;
}

export interface CredentialStore {
  read(key: string): Promise<StoredRecord | null>;
  write(key: string, record: StoredRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * The store for a process that does not need persistence.
 *
 * Not only a test double. A single-user desktop app, or a CLI that signs in and does its work
 * in one run, genuinely has nowhere better to put this — and paying for a database to hold one
 * row that expires in an hour is not a virtue.
 */
export class MemoryCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, StoredRecord>();

  async read(key: string): Promise<StoredRecord | null> {
    return this.rows.get(key) ?? null;
  }

  async write(key: string, record: StoredRecord): Promise<void> {
    this.rows.set(key, record);
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }
}
