import { describe, expect, it } from 'vitest';
import { MODELS, modelSpec, modelsFor, pricingKeyFor } from './models.js';
import { isPricingKnown, pricingFor, PRICING, UNKNOWN_MODEL_PRICING } from './pricing.js';

describe('modelsFor', () => {
  it('offers only models that speak the provider\'s wire', () => {
    expect(modelsFor('anthropic').every((m) => m.wire === 'anthropic')).toBe(true);
    expect(modelsFor('openai').every((m) => m.wire === 'openai')).toBe(true);
    // A subscription speaks the same wire as its metered sibling, so it gets the same list.
    expect(modelsFor('claude-code').map((m) => m.id)).toEqual(modelsFor('anthropic').map((m) => m.id));
    expect(modelsFor('codex').map((m) => m.id)).toEqual(modelsFor('openai').map((m) => m.id));
  });

  it('puts the lightest first, because that is what a rate-limited plan needs', () => {
    const tiers = modelsFor('anthropic').map((m) => m.tier);
    expect(tiers[0]).toBe('light');
    expect(tiers[tiers.length - 1]).toBe('heavy');
  });

  it('describes every model it lists', () => {
    for (const model of MODELS) {
      expect(model.label.length).toBeGreaterThan(0);
      expect(model.note.length).toBeGreaterThan(0);
    }
  });

  it('finds a model by id, and admits when it cannot', () => {
    expect(modelSpec('claude-sonnet-5')?.label).toBe('Sonnet 5');
    expect(modelSpec('something-invented')).toBeNull();
  });
});

describe('pricingKeyFor', () => {
  it('matches an exact id', () => {
    expect(pricingKeyFor('claude-opus-5')).toBe('claude-opus-5');
  });

  it('sees through a dated suffix, which is the id you actually call', () => {
    // The bug this exists for: a correctly configured deployment running the dated id was
    // told its model had no published rate, and its budget guard priced it five times high.
    expect(pricingKeyFor('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(pricingFor('claude-haiku-4-5-20251001')).toEqual(PRICING['claude-haiku-4-5']);
    expect(isPricingKnown('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('will not let a longer model be swallowed by a shorter one', () => {
    // `gpt-4.1-mini` starts with `gpt-4.1`, and is four times cheaper. Matching it to the
    // wrong row would misprice every call in the safe-looking direction.
    expect(pricingKeyFor('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(pricingFor('gpt-4.1-mini')).toEqual(PRICING['gpt-4.1-mini']);
  });

  it('refuses a suffix that is not a date', () => {
    expect(pricingKeyFor('claude-haiku-4-5-turbo')).toBeNull();
    expect(pricingFor('claude-haiku-4-5-turbo')).toEqual(UNKNOWN_MODEL_PRICING);
  });

  it('is null for a model nothing knows, so the guard stays pessimistic', () => {
    expect(pricingKeyFor('made-up-model')).toBeNull();
    expect(isPricingKnown('made-up-model')).toBe(false);
  });

  it('prices every catalogued model from the table rather than the fallback', () => {
    for (const model of MODELS) {
      expect(isPricingKnown(model.id), `${model.id} has no published rate`).toBe(true);
    }
  });
});
