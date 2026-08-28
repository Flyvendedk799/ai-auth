/**
 * Turning a provider's failure into a sentence someone can act on.
 *
 * Everything that goes wrong out at the model arrives as an SDK error whose message is the
 * raw response body — `429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}`
 * — and forwarding that to a browser verbatim is the default. It says what happened in the
 * protocol and nothing about what to do, which is the only part a person needs.
 *
 * The remedy also depends on *how the call was paid for*, which is why this takes a provider.
 * A 429 on a metered key means "you are sending too fast"; the same status on a subscription
 * means the plan's own allowance is used up — often by something else entirely, because a
 * plan is shared with every tool signed in to it, the `claude` CLI included. Those are
 * different problems with different fixes, and a single "rate limited" would send half the
 * people who see it to the wrong one.
 *
 * Kept as a pure function of (error, provider, model) so the mapping is testable without a
 * network, which matters: every branch here is a thing that only happens when something is
 * already going wrong, and those are exactly the paths nobody exercises by hand.
 */

import { isSubscription, type ModelId, type ProviderId } from './pricing.js';

/** The bits of an SDK error this needs. Both SDKs expose `status`; neither guarantees it. */
interface ProviderErrorLike {
  status?: number;
  message?: string;
  name?: string;
}

function statusOf(error: unknown): number | null {
  const status = (error as ProviderErrorLike | null)?.status;
  return typeof status === 'number' ? status : null;
}

/** The provider's own words, when it bothered to say anything useful. */
function detailOf(error: unknown): string | null {
  const raw = (error as ProviderErrorLike | null)?.message;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // The SDKs prefix the body with the status and then hand over JSON. Dig out the human part
  // if there is one, and ignore the placeholder "Error" that Anthropic sends for a 429.
  const match = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const message = match?.[1]?.replace(/\\"/g, '"');
  if (!message || message === 'Error') return null;
  return message;
}

/** Which CLI owns the login behind a subscription provider, for the "run this" sentence. */
function cliFor(provider: ProviderId): string {
  return provider === 'codex' ? 'codex' : 'claude';
}

/**
 * A message for the browser, or null when nothing better than the raw error can be said.
 *
 * Null rather than a vague catch-all: "something went wrong" is worse than the status code
 * and the body, which at least give someone something to search for.
 */
export function describeProviderError(
  error: unknown,
  provider: ProviderId,
  model: ModelId,
): string | null {
  const status = statusOf(error);
  const detail = detailOf(error);
  const subscription = isSubscription(provider);
  const cli = cliFor(provider);

  if (status === 429) {
    return subscription
      ? `Your ${provider === 'codex' ? 'ChatGPT' : 'Claude'} plan is rate-limited right now, so the ` +
          'call was refused before it started. A plan is shared by everything signed in to ' +
          `it — including the \`${cli}\` CLI — so another tool may be using the allowance. Wait a ` +
          'few minutes, pick a lighter model, or switch to an API key.'
      : 'The provider is rate-limiting this key. Wait a moment and try again, or slow down how ' +
          'many calls run at once.';
  }

  if (status === 401 || status === 403) {
    return subscription
      ? `The ${cli} login on the server was rejected. Run \`${cli}\` on that machine and sign in ` +
          'again, then try once more — there is nothing to paste anywhere.'
      : 'The API key was rejected — a key that has been revoked or rotated fails exactly like this.';
  }

  if (status === 400 && detail) {
    // Almost always a model that does not accept something the request carried. Name the model,
    // because the setting that caused it is a free-text box and the message is about a
    // parameter the user never typed.
    return `${detail} (model: ${model}). Choose a different model.`;
  }

  if (status === 404) {
    return `The provider does not know a model called \`${model}\`. Check the model name.`;
  }

  if (status !== null && status >= 500) {
    return 'The provider had a server error. That is on their side — try again shortly.';
  }

  if (status === 529) {
    return 'The provider is overloaded. Try again shortly.';
  }

  return detail;
}
