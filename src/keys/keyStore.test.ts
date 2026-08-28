import { describe, expect, it } from 'vitest';
import { ApiKeyStore } from './keyStore.js';
import { MemoryCredentialStore } from '../store/types.js';

function makeStore(env: Record<string, string | undefined> = {}) {
  const store = new MemoryCredentialStore();
  return {
    store,
    keys: new ApiKeyStore({ store, secret: 'host-secret', env }),
  };
}

describe('ApiKeyStore', () => {
  it('stores and resolves a key', async () => {
    const { keys } = makeStore();
    await keys.set('anthropic', 'sk-ant-api03-secret');
    expect(await keys.resolve('anthropic')).toEqual({
      key: 'sk-ant-api03-secret',
      source: 'stored',
      ready: true,
    });
  });

  it('never writes the key in the clear', async () => {
    const { store, keys } = makeStore();
    await keys.set('openai', 'sk-proj-plaintext-would-be-a-bug');
    const record = await store.read('key:openai');
    expect(record!.payload).not.toContain('plaintext');
  });

  it('falls back to the environment, and says that is where it came from', async () => {
    const { keys } = makeStore({ ANTHROPIC_API_KEY: 'sk-ant-from-env' });
    expect(await keys.resolve('anthropic')).toEqual({
      key: 'sk-ant-from-env',
      source: 'environment',
      ready: true,
    });
  });

  it('prefers a stored key over the environment', async () => {
    const { keys } = makeStore({ ANTHROPIC_API_KEY: 'sk-ant-from-env' });
    await keys.set('anthropic', 'sk-ant-from-settings');
    const resolved = await keys.resolve('anthropic');
    expect(resolved.key).toBe('sk-ant-from-settings');
    expect(resolved.source).toBe('stored');
  });

  it('reports a subscription provider as ready with no key, not as unconfigured', async () => {
    // The distinction that matters: "none" would put a "paste a key" prompt in front of a
    // deployment whose credential is an OAuth login and is perfectly well configured.
    const { keys } = makeStore();
    expect(await keys.resolve('claude-code')).toEqual({
      key: null,
      source: 'subscription',
      ready: true,
    });
    expect(await keys.resolve('codex')).toEqual({
      key: null,
      source: 'subscription',
      ready: true,
    });
  });

  it('reports not-ready when a metered provider has nothing anywhere', async () => {
    const { keys } = makeStore();
    expect(await keys.resolve('openai')).toEqual({ key: null, source: 'none', ready: false });
  });

  it('routes a provider to its own wire, so a Claude key is never read for OpenAI', async () => {
    const { keys } = makeStore();
    await keys.set('anthropic', 'sk-ant-only');
    expect((await keys.resolve('openai')).key).toBeNull();
    // Claude Code speaks the Anthropic wire but borrows nothing from an Anthropic key.
    expect((await keys.resolve('claude-code')).key).toBeNull();
  });

  it('clears a key when set to null or to blank', async () => {
    const { keys } = makeStore();
    await keys.set('anthropic', 'sk-ant-temp');
    await keys.set('anthropic', null);
    expect(await keys.stored('anthropic')).toBeNull();

    await keys.set('anthropic', 'sk-ant-temp');
    await keys.set('anthropic', '   ');
    expect(await keys.stored('anthropic')).toBeNull();
  });

  it('trims what was pasted, because a trailing newline is not part of anyone key', async () => {
    const { keys } = makeStore();
    await keys.set('openai', '  sk-proj-pasted\n');
    expect(await keys.stored('openai')).toBe('sk-proj-pasted');
  });

  it('hints at a key without being a way to read one', async () => {
    const { keys } = makeStore();
    await keys.set('anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA9ZQ');
    const hint = await keys.hint('anthropic');
    expect(hint).toBe('sk-ant-…A9ZQ');
    expect(hint).not.toContain('AAAA');
  });

  it('hints at an environment key too, so a working deployment does not look empty', async () => {
    const { keys } = makeStore({ OPENAI_API_KEY: 'sk-proj-envenvenvenv1234' });
    expect(await keys.hint('openai')).toBe('sk-proj…1234');
  });

  it('treats an unreadable row as unset rather than throwing', async () => {
    const store = new MemoryCredentialStore();
    const keys = new ApiKeyStore({ store, secret: 'host-secret', env: {} });
    await keys.set('anthropic', 'sk-ant-real');

    // What a rotated host secret looks like from here.
    const rotated = new ApiKeyStore({ store, secret: 'a-different-secret', env: {} });
    expect(await rotated.stored('anthropic')).toBeNull();
    expect((await rotated.resolve('anthropic')).ready).toBe(false);
  });

  it('keeps namespaces apart, so two apps can share one table', async () => {
    const store = new MemoryCredentialStore();
    const one = new ApiKeyStore({ store, secret: 's', namespace: 'app-one', env: {} });
    const two = new ApiKeyStore({ store, secret: 's', namespace: 'app-two', env: {} });

    await one.set('anthropic', 'sk-ant-one');
    expect(await two.stored('anthropic')).toBeNull();
    expect(await one.stored('anthropic')).toBe('sk-ant-one');
  });
});

describe('ApiKeyStore secretLabel', () => {
  it('opens keys written under a label some earlier code used', async () => {
    const store = new MemoryCredentialStore();
    const legacy = new ApiKeyStore({
      store,
      secret: 'host-secret',
      secretLabel: 'someapp-settings',
      env: {},
    });
    await legacy.set('anthropic', 'sk-ant-already-stored');

    const adopted = new ApiKeyStore({
      store,
      secret: 'host-secret',
      secretLabel: 'someapp-settings',
      env: {},
    });
    expect(await adopted.stored('anthropic')).toBe('sk-ant-already-stored');

    const wrong = new ApiKeyStore({ store, secret: 'host-secret', env: {} });
    expect(await wrong.stored('anthropic')).toBeNull();
  });
});
