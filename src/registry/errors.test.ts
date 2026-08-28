import { describe, expect, it } from 'vitest';
import { describeProviderError, providerErrorFacts } from './errors.js';

const err = (status: number, message?: string) => ({ status, message });

describe('describeProviderError', () => {
  it('tells a rate-limited plan and a rate-limited key apart', () => {
    const plan = describeProviderError(err(429), 'claude-code', 'claude-opus-5')!;
    const key = describeProviderError(err(429), 'anthropic', 'claude-opus-5')!;

    // The same status with different remedies. One "rate limited" would send half the people
    // who saw it to the wrong fix.
    expect(plan).toMatch(/plan refused this call for `claude-opus-5`/);
    expect(plan).toMatch(/limits each model separately/);
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

/** An SDK error carrying real response headers, which is where the interesting facts live. */
function withHeaders(status: number, headers: Record<string, string>, message = '') {
  return { status, message, headers: new Headers(headers) };
}

describe('a 429 is not automatically an exhausted plan', () => {
  it('says so plainly when the plan reports itself allowed', () => {
    // The case that sent someone hunting for a plan problem they did not have: 429 from the
    // edge, plan at 19% of its window, everything about the allowance perfectly fine.
    const message = describeProviderError(
      withHeaders(429, {
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.19',
        'retry-after': '4',
      }),
      'claude-code',
      'claude-haiku-4-5',
    )!;

    expect(message).toMatch(/says the plan is still allowed/);
    expect(message).toMatch(/19% of its overall window used/);
    expect(message).toMatch(/wait 4 seconds/);
    // The thing it must never say here.
    expect(message).not.toMatch(/plan refused this call/);
  });

  it('still blames the plan when the plan is the one refusing', () => {
    const message = describeProviderError(
      withHeaders(429, { 'anthropic-ratelimit-unified-status': 'rejected', 'retry-after': '900' }),
      'claude-code',
      'claude-opus-5',
    )!;
    expect(message).toMatch(/plan refused this call/);
    expect(message).toMatch(/wait 900 seconds/);
  });

  it('falls back to blaming the plan when there are no headers to say otherwise', () => {
    // No header is not evidence of innocence — an old SDK, or an error we synthesised, gets
    // the conservative reading rather than the reassuring one.
    expect(describeProviderError({ status: 429 }, 'claude-code', 'claude-opus-5')).toMatch(
      /plan refused this call/,
    );
  });

  it('carries retry-after into the metered-key message too', () => {
    expect(
      describeProviderError(withHeaders(429, { 'retry-after': '12' }), 'anthropic', 'claude-opus-5'),
    ).toMatch(/rate-limiting this key\. It asked us to wait 12 seconds\./);
  });
});

describe('providerErrorFacts', () => {
  it('reads what the response actually said', () => {
    expect(
      providerErrorFacts(
        withHeaders(
          429,
          {
            'retry-after': '7',
            'anthropic-ratelimit-unified-status': 'allowed',
            'anthropic-ratelimit-unified-5h-utilization': '0.42',
          },
          '429 {"error":{"message":"slow down"}}',
        ),
      ),
    ).toEqual({ status: 429, retryAfter: 7, planStatus: 'allowed', utilization: 0.42, detail: 'slow down' });
  });

  it('reads a plain header object as readily as a Headers', () => {
    const facts = providerErrorFacts({ status: 429, headers: { 'retry-after': '3' } });
    expect(facts.retryAfter).toBe(3);
  });

  it('is all nulls for an error that carries nothing', () => {
    expect(providerErrorFacts(new Error('socket hang up'))).toEqual({
      status: null,
      retryAfter: null,
      planStatus: null,
      utilization: null,
      detail: null,
    });
  });
});

describe('a subscription limits each model separately', () => {
  it('names the model that was refused, and says a lighter one may still work', () => {
    // The production case this was written for. The plan sat at 19% of its overall window and
    // answered Haiku with a 200 in the same second it refused Sonnet with a 429 — so "your
    // plan is rate-limited" was both true and useless, and sent the reader off to wait out an
    // allowance that was never the thing standing in the way.
    const message = describeProviderError({ status: 429 }, 'claude-code', 'claude-sonnet-5')!;

    expect(message).toMatch(/refused this call for `claude-sonnet-5`/);
    expect(message).toMatch(/limits each model separately/);
    expect(message).toMatch(/switching model is usually the fastest fix/);
  });

  it('names the model in the allowed-but-refused branch too', () => {
    const message = describeProviderError(
      withHeaders(429, { 'anthropic-ratelimit-unified-status': 'allowed' }),
      'claude-code',
      'claude-opus-5',
    )!;
    expect(message).toMatch(/`claude-opus-5` may be exhausted while a lighter one still answers/);
  });

  it('says nothing about models for a metered key, which has no per-model plan', () => {
    const message = describeProviderError({ status: 429 }, 'anthropic', 'claude-sonnet-5')!;
    expect(message).toMatch(/rate-limiting this key/);
    expect(message).not.toMatch(/each model separately/);
  });
});
