/**
 * Every adapter, against one contract.
 *
 * Written as a shared suite rather than three suites, because the point of the interface is
 * that a caller cannot tell which one it has. A behaviour that only Postgres gets right is a
 * behaviour the memory store will break in someone's tests, and vice versa.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryCredentialStore, type CredentialStore } from './types.js';
import { JsonFileCredentialStore } from './jsonFile.js';
import { PostgresCredentialStore, SCHEMA_SQL, type Queryable } from './postgres.js';

/** Just enough Postgres to run the adapter's three statements. Not a SQL engine. */
function fakePostgres(): Queryable & { rows: Map<string, { payload: string; meta: unknown }> } {
  const rows = new Map<string, { payload: string; meta: unknown }>();
  return {
    rows,
    async query<R>(text: string, values: unknown[] = []) {
      const key = String(values[0]);
      if (text.startsWith('SELECT')) {
        const row = rows.get(key);
        return { rows: (row ? [row] : []) as R[] };
      }
      if (text.startsWith('INSERT')) {
        rows.set(key, { payload: String(values[1]), meta: JSON.parse(String(values[2])) });
        return { rows: [] as R[] };
      }
      if (text.startsWith('DELETE')) {
        rows.delete(key);
        return { rows: [] as R[] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

const temporaries: string[] = [];
afterAll(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

const ADAPTERS: [string, () => Promise<CredentialStore>][] = [
  ['MemoryCredentialStore', async () => new MemoryCredentialStore()],
  [
    'JsonFileCredentialStore',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ai-auth-'));
      temporaries.push(dir);
      return new JsonFileCredentialStore({ path: join(dir, 'creds.json') });
    },
  ],
  ['PostgresCredentialStore', async () => new PostgresCredentialStore({ db: fakePostgres() })],
];

describe.each(ADAPTERS)('%s', (_name, make) => {
  it('is empty before anything is written', async () => {
    expect(await (await make()).read('nobody')).toBeNull();
  });

  it('round-trips a record, payload and meta alike', async () => {
    const store = await make();
    await store.write('u1', { payload: 'sealed', meta: { plan: 'max', expiresAt: 42 } });
    expect(await store.read('u1')).toEqual({
      payload: 'sealed',
      meta: { plan: 'max', expiresAt: 42 },
    });
  });

  it('overwrites rather than duplicating', async () => {
    const store = await make();
    await store.write('u1', { payload: 'one', meta: {} });
    await store.write('u1', { payload: 'two', meta: {} });
    expect((await store.read('u1'))!.payload).toBe('two');
  });

  it('keeps keys apart', async () => {
    const store = await make();
    await store.write('u1', { payload: 'one', meta: {} });
    await store.write('u2', { payload: 'two', meta: {} });
    expect((await store.read('u1'))!.payload).toBe('one');
    expect((await store.read('u2'))!.payload).toBe('two');
  });

  it('deletes, and deleting something absent is not an error', async () => {
    const store = await make();
    await store.write('u1', { payload: 'one', meta: {} });
    await store.delete('u1');
    await store.delete('u1');
    expect(await store.read('u1')).toBeNull();
  });

  it('preserves a null in meta rather than dropping the field', async () => {
    const store = await make();
    await store.write('u1', { payload: 'p', meta: { plan: null } });
    expect((await store.read('u1'))!.meta).toEqual({ plan: null });
  });
});

describe('JsonFileCredentialStore', () => {
  it('survives concurrent writes, which a read-modify-write would lose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-auth-'));
    temporaries.push(dir);
    const path = join(dir, 'creds.json');
    const store = new JsonFileCredentialStore({ path });

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.write(`u${i}`, { payload: `p${i}`, meta: { n: i } }),
      ),
    );

    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(
      ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'],
    );
  });

  it('reads a corrupt file as empty rather than throwing at boot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-auth-'));
    temporaries.push(dir);
    const path = join(dir, 'creds.json');
    const store = new JsonFileCredentialStore({ path });
    await store.write('u1', { payload: 'p', meta: {} });

    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ this is not json', 'utf8');
    expect(await store.read('u1')).toBeNull();

    // And it recovers: the next write replaces the damaged file.
    await store.write('u2', { payload: 'q', meta: {} });
    expect((await store.read('u2'))!.payload).toBe('q');
  });

  it('creates its directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-auth-'));
    temporaries.push(dir);
    const store = new JsonFileCredentialStore({ path: join(dir, 'nested', 'deep', 'creds.json') });
    await store.write('u1', { payload: 'p', meta: {} });
    expect((await store.read('u1'))!.payload).toBe('p');
  });
});

describe('PostgresCredentialStore', () => {
  it('refuses a table name it would have to interpolate unsafely', () => {
    const db = fakePostgres();
    expect(() => new PostgresCredentialStore({ db, table: 'creds; DROP TABLE users' })).toThrow(
      /unsafe table name/i,
    );
    expect(() => new PostgresCredentialStore({ db, table: 'my_creds' })).not.toThrow();
  });

  it('parameterises the key rather than interpolating it', async () => {
    const db = fakePostgres();
    const seen: string[] = [];
    const spy: Queryable = {
      query: async (text, values) => {
        seen.push(text);
        return db.query(text, values);
      },
    };
    await new PostgresCredentialStore({ db: spy }).read("bobby'); DROP TABLE --");
    expect(seen[0]).toContain('$1');
    expect(seen[0]).not.toContain('bobby');
  });

  it('ships a schema that names the same table it queries', () => {
    expect(SCHEMA_SQL).toContain('ai_auth_credentials');
  });
});
