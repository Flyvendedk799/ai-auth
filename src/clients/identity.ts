/**
 * The system block a Claude Code OAuth token has to carry.
 *
 * This is not decoration and it is not optional. Authenticating with a subscription token and
 * *not* sending it gets the premium models refused — with HTTP 429 and a `rate_limit_error`,
 * which is as misleading a status as the API could have picked, because the plan is nowhere
 * near its limit and the same token answers instantly on a lighter model.
 *
 * Established by experiment against the live API, on one account, within a few seconds, with
 * only the system prompt varying:
 *
 *     opus-5   identity as the first system block                    → 200
 *     opus-5   identity as the second block                          → 429
 *     opus-5   a different opening sentence                          → 429
 *     opus-5   identity concatenated into one block with the prompt  → 429
 *     opus-5   no identity at all                                    → 429
 *     sonnet-5 identity as the first system block                    → 200
 *     haiku    no identity at all                                    → 200
 *
 * So three things are load-bearing, and each was a separate 429 before it was understood:
 * the text must match exactly, it must be the **first** block, and it must be a block **of its
 * own** — folding it into the front of your own prompt does not count.
 *
 * Haiku's exemption is the trap. It is the natural model to test with, being cheap and fast,
 * and it passes without the identity — so a request shape that is broken for every model
 * anyone actually wants looks perfectly healthy on the one they tried.
 *
 * The usual caveat applies, and harder here than anywhere else in this library: this makes
 * your request claim to be Claude Code, because that is whose client id minted the token and
 * whose plan is paying. Read the subscription terms before pointing a hosted product at a
 * consumer plan.
 */

/** Exactly what the CLI sends. Not paraphrasable — a different sentence is refused. */
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

/** The shape the Messages API takes for a system prompt. */
export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Your system prompt, with the identity block in front of it.
 *
 * Accepts a bare string or blocks you have already built, and is a no-op when the identity is
 * already first — so it is safe to apply at more than one layer, which matters because the
 * layer that knows the credential is a subscription is rarely the layer that owns the prompt.
 *
 * The identity block is deliberately left uncached. It is one short sentence, caching has a
 * minimum size, and each `cache_control` marker spends one of the four breakpoints a request
 * is allowed — better spent on the prompt that is actually long.
 */
export function withClaudeCodeIdentity(system: string | readonly SystemBlock[]): SystemBlock[] {
  const blocks: SystemBlock[] =
    typeof system === 'string' ? [{ type: 'text', text: system }] : [...system];

  if (blocks[0]?.text === CLAUDE_CODE_SYSTEM) return blocks;
  return [{ type: 'text', text: CLAUDE_CODE_SYSTEM }, ...blocks];
}
