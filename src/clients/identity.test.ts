import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_SYSTEM, withClaudeCodeIdentity } from './identity.js';

describe('withClaudeCodeIdentity', () => {
  it('puts the identity in a block of its own, in front', () => {
    // All three properties are load-bearing and each was a separate 429: exact text, first
    // position, own block. Concatenating it into the caller's prompt does not work.
    expect(withClaudeCodeIdentity('You build things.')).toEqual([
      { type: 'text', text: CLAUDE_CODE_SYSTEM },
      { type: 'text', text: 'You build things.' },
    ]);
  });

  it('keeps blocks the caller already built, cache markers and all', () => {
    const own = [{ type: 'text' as const, text: 'big prompt', cache_control: { type: 'ephemeral' as const } }];
    expect(withClaudeCodeIdentity(own)).toEqual([
      { type: 'text', text: CLAUDE_CODE_SYSTEM },
      { type: 'text', text: 'big prompt', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('does not add it twice', () => {
    // Applied at two layers on purpose sometimes: the layer that knows the credential is a
    // subscription is rarely the layer that owns the prompt.
    const once = withClaudeCodeIdentity('prompt');
    expect(withClaudeCodeIdentity(once)).toEqual(once);
  });

  it('leaves the identity block uncached', () => {
    // One short sentence, below the cache minimum, and each marker spends one of the four
    // breakpoints a request gets.
    expect(withClaudeCodeIdentity('prompt')[0]).not.toHaveProperty('cache_control');
  });

  it('is the exact sentence, not a paraphrase', () => {
    // A different opening sentence is refused, so this string is an API contract.
    expect(CLAUDE_CODE_SYSTEM).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it('handles an empty prompt without losing the identity', () => {
    expect(withClaudeCodeIdentity('')).toEqual([
      { type: 'text', text: CLAUDE_CODE_SYSTEM },
      { type: 'text', text: '' },
    ]);
  });
});
