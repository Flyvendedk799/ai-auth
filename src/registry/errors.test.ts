import { describe, expect, it } from 'vitest';
import { describeProviderError } from './errors.js';

const err = (status: number, message?: string) => ({ status, message });

describe('describeProviderError', () => {
  it('tells a rate-limited plan and a rate-limited key apart', () => {
    const plan = describeProviderError(err(429), 'claude-code', 'claude-opus-5')!;
    const key = describeProviderError(err(429), 'anthropic', 'claude-opus-5')!;

    // The same status with different remedies. One "rate limited" would send half the people
    // who saw it to the wrong fix.
    expect(plan).toMatch(/plan is rate-limited/);
    expect(plan).toMatch(/`claude` CLI/);
    expect(key).toMatch(/rate-limiting this key/);
    expect(key).not.toMatch(/plan/);
  });

  it('names the CLI that owns a rejected subscription login', () => {
    expect(describeProviderError(err(401), 'codex', 'gpt-5')).toMatch(/run `codex`/i);
    expect(describeProviderError(err(403), 'claude-code', 'claude-opus-5')).toMatch(/run `claude`/i);
  });

  it('says where to change things only when it has been told', () => {
    const without = describeProviderError(err(404), 'anthropic', 'made-up-model')!;
    const with_ = describeProviderError(err(404), 'anthropic', 'made-up-model', {
      configureAt: 'Settings',
    })!;

    expect(without).toBe('The provider does not know a model called `made-up-model`. Check the model name.');
    expect(with_).toBe(
      'The provider does not know a model called `made-up-model`. Check the model name in Settings.',
    );
  });

  it('threads the same phrase through every instruction it appears in', () => {
    const at = { configureAt: 'the admin page' };
    expect(describeProviderError(err(429), 'codex', 'gpt-5', at)).toMatch(/API key in the admin page/);
    expect(describeProviderError(err(401), 'openai', 'gpt-5', at)).toMatch(/check it in the admin page/);
    expect(
      describeProviderError(err(400, '{"message":"unsupported parameter"}'), 'openai', 'gpt-5', at),
    ).toMatch(/different model in the admin page/);
  });

  it('digs the human sentence out of a JSON body and ignores the placeholder', () => {
    expect(describeProviderError(err(400, '400 {"error":{"message":"bad thing"}}'), 'openai', 'gpt-5'))
      .toMatch(/^bad thing \(model: gpt-5\)/);
    // Anthropic sends a literal "Error" for a 429; using it would be worse than the status.
    expect(describeProviderError(err(500, '{"message":"Error"}'), 'openai', 'gpt-5')).toMatch(
      /server error/,
    );
  });

  it('is null when it has nothing better to say than the raw error', () => {
    expect(describeProviderError(err(418), 'openai', 'gpt-5')).toBeNull();
    expect(describeProviderError(new Error('socket hang up'), 'openai', 'gpt-5')).toBeNull();
  });
});
