import { describe, expect, it } from 'vitest';
import { maskSecret, SecretBox } from './secretBox.js';

describe('SecretBox', () => {
  const box = new SecretBox('a-host-secret-with-real-entropy', 'test');

  it('round-trips a value', () => {
    expect(box.open(box.seal('sk-ant-api03-abcdef'))).toBe('sk-ant-api03-abcdef');
  });

  it('produces a different ciphertext every time, so equal keys are not equal rows', () => {
    expect(box.seal('same')).not.toBe(box.seal('same'));
  });

  it('round-trips JSON, which is how a token payload is stored', () => {
    const value = { accessToken: 'tok', refreshToken: null, scopes: ['user:inference'] };
    expect(box.openJson(box.sealJson(value))).toEqual(value);
  });

  it('refuses a value sealed under a different label', () => {
    // The property the labels exist for: two stores sharing one host secret must not be able
    // to read each other's rows, so a bug that reads the wrong row fails loudly.
    const other = new SecretBox('a-host-secret-with-real-entropy', 'other');
    expect(other.open(box.seal('secret'))).toBeNull();
  });

  it('refuses a value sealed under a different host secret', () => {
    const rotated = new SecretBox('the-secret-was-rotated', 'test');
    expect(rotated.open(box.seal('secret'))).toBeNull();
  });

  it('detects tampering rather than decrypting to garbage', () => {
    const sealed = box.seal('transfer $10');
    const [iv, tag, data] = sealed.split(':') as [string, string, string];
    const flipped = `${data.slice(0, -2)}${data.slice(-2) === 'ff' ? '00' : 'ff'}`;
    expect(box.open(`${iv}:${tag}:${flipped}`)).toBeNull();
  });

  it('returns null for anything that is not one of ours, instead of throwing', () => {
    expect(box.open('')).toBeNull();
    expect(box.open('not-even-close')).toBeNull();
    expect(box.open('zz:zz:zz')).toBeNull();
    expect(box.openJson('nonsense')).toBeNull();
  });

  it('returns null when the plaintext opens but is not JSON', () => {
    expect(box.openJson(box.seal('plain text'))).toBeNull();
  });

  it('refuses to be built without a secret or without a label', () => {
    expect(() => new SecretBox('', 'label')).toThrow(/secret/);
    expect(() => new SecretBox('secret', '')).toThrow(/label/);
  });
});

describe('maskSecret', () => {
  it('keeps the head, which names the kind of key, and the tail, which identifies it', () => {
    expect(maskSecret('sk-ant-api03-AAAAAAAAAAAAAAAAAAAA9ZQ')).toBe('sk-ant-…A9ZQ');
  });

  it('shows nothing at all of a short value, rather than most of it', () => {
    expect(maskSecret('sk-abc')).toBe('••••');
    expect(maskSecret('123456789012')).toBe('••••');
  });
});
