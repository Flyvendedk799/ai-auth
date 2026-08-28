/**
 * A credential store that is one JSON file.
 *
 * For the shape of project that has no database and does not want one: a desktop app, a
 * self-hosted single-user server, a tool that runs on a laptop. The payloads in it are already
 * sealed, so the file at rest is not a plaintext secret — but it is still a file full of
 * things worth stealing, so it is written `0600` and the directory `0700`.
 *
 * Writes go through a temporary file and a rename. A process killed halfway through writing
 * this file would otherwise leave truncated JSON, and the failure mode of that is every
 * credential in it becoming unreadable at once — which reads to the user as "the app logged
 * me out and lost my key", from a crash that had nothing to do with either.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CredentialStore, StoredRecord } from './types.js';

export interface JsonFileStoreOptions {
  /** Absolute path. Its directory is created if missing. */
  path: string;
}

export class JsonFileCredentialStore implements CredentialStore {
  /** Serialises writes: two concurrent saves through rename would lose one of them. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: JsonFileStoreOptions) {}

  private async load(): Promise<Record<string, StoredRecord>> {
    try {
      const raw = await readFile(this.options.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, StoredRecord>)
        : {};
    } catch {
      // Missing, unreadable, or corrupt all mean the same thing to a caller: nothing is
      // stored yet. Throwing here would make a damaged file a boot failure.
      return {};
    }
  }

  private mutate(change: (rows: Record<string, StoredRecord>) => void): Promise<void> {
    const work = this.queue.then(async () => {
      const rows = await this.load();
      change(rows);
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.options.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(rows, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.options.path);
    });
    // The queue must survive a failed write, or one error would wedge every write after it.
    this.queue = work.catch(() => undefined);
    return work;
  }

  async read(key: string): Promise<StoredRecord | null> {
    const rows = await this.load();
    return rows[key] ?? null;
  }

  async write(key: string, record: StoredRecord): Promise<void> {
    await this.mutate((rows) => {
      rows[key] = record;
    });
  }

  async delete(key: string): Promise<void> {
    await this.mutate((rows) => {
      delete rows[key];
    });
  }
}
