/**
 * A credential store backed by one Postgres table.
 *
 * `pg` is not a dependency of this package and is not imported here. The adapter asks for the
 * one method it uses — a parameterised `query` — which every Postgres client in Node already
 * exposes under that name, so a `pg.Pool`, a `pg.Client` or a hand-rolled wrapper all satisfy
 * it as they are. That keeps the consumer in charge of their own driver version, their own
 * pool settings and their own connection lifecycle, none of which a credential store has any
 * business having an opinion about.
 *
 * The schema is in `SCHEMA_SQL` rather than applied automatically. Silently creating tables in
 * someone else's database is a bad habit for a library: projects have migration tools, and a
 * table that appeared without passing through one is a table nobody can roll back.
 */

import type { CredentialStore, StoredRecord } from './types.js';

/** The subset of a `pg` client this uses. Structural, so `pg.Pool` satisfies it unmodified. */
export interface Queryable {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface PostgresStoreOptions {
  db: Queryable;
  /** Defaults to `ai_auth_credentials`. Set it if you keep more than one namespace. */
  table?: string;
}

/**
 * Run this through your own migration tool.
 *
 * `meta` is `jsonb` so the small facts kept beside the payload — plan, expiry — can be read
 * and indexed without opening the sealed blob, which is the whole reason they are not in it.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_auth_credentials (
  key        text PRIMARY KEY,
  payload    text NOT NULL,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`.trim();

export class PostgresCredentialStore implements CredentialStore {
  private readonly table: string;

  constructor(private readonly options: PostgresStoreOptions) {
    const table = options.table ?? 'ai_auth_credentials';
    // Interpolated into SQL, so it is checked rather than trusted. The value comes from the
    // host's own config and not from a request, but "not reachable from user input today" is
    // a property that quietly stops being true.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`Unsafe table name: ${table}`);
    }
    this.table = table;
  }

  async read(key: string): Promise<StoredRecord | null> {
    const { rows } = await this.options.db.query<{ payload: string; meta: unknown }>(
      `SELECT payload, meta FROM ${this.table} WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      payload: row.payload,
      meta:
        typeof row.meta === 'object' && row.meta !== null
          ? (row.meta as StoredRecord['meta'])
          : {},
    };
  }

  async write(key: string, record: StoredRecord): Promise<void> {
    await this.options.db.query(
      `INSERT INTO ${this.table} (key, payload, meta, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE
         SET payload = EXCLUDED.payload,
             meta = EXCLUDED.meta,
             updated_at = now()`,
      [key, record.payload, JSON.stringify(record.meta)],
    );
  }

  async delete(key: string): Promise<void> {
    await this.options.db.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]);
  }
}
