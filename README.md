# ai-auth

Bring-your-own-credential auth for Anthropic and OpenAI.

Three ways to pay for a model call, behind one small set of pieces:

- **A Claude subscription the user signs in to, in your app.** OAuth with PKCE, the same flow `claude` runs, driven from a browser. Each account brings its own plan, so a call costs the person who asked for it rather than whoever set the server up.
- **A subscription already signed in on the machine.** If `claude` or `codex` is logged in on the box, the credential is already there. Read it, use it, never disturb it.
- **An ordinary API key.** Encrypted at rest, resolved from storage or the environment, masked for display and never readable back out.

No runtime dependencies. Node built-ins only. Fastify and React are optional peers behind their own entry points, and neither SDK is a dependency at all.

```
npm i github:Flyvendedk799/ai-auth
```

---

## Read this first

Most of what this library is *for* is a handful of details that are individually tiny and each cost a day to find out. They are gathered in [Traps](#traps-each-of-these-cost-a-day) at the end. If you are wiring up a Claude subscription and it is behaving strangely, start there — particularly [the identity block](#1-a-subscription-token-must-say-it-is-claude-code), which is the one that will get you.

---

## Entry points

| import | contains | runs where |
|---|---|---|
| `@flyvendedk799/ai-auth` | credentials, stores, everything below | Node only |
| `@flyvendedk799/ai-auth/registry` | providers, models, pricing, error messages | anywhere, incl. browsers |
| `@flyvendedk799/ai-auth/fastify` | the four login routes | Node, needs Fastify |
| `@flyvendedk799/ai-auth/react` | the terminal-shell login component | browser, needs React |
| `@flyvendedk799/ai-auth/postgres` | the Postgres credential store | Node |

The root is Node-only: it imports `node:crypto`. A settings page that wants the model catalogue must import `/registry`, or the bundle will not build.

---

## The shortest useful example

```ts
import {
  ApiKeyStore, ClaudeAccountStore, MemoryCredentialStore,
  anthropicSubscriptionOptions, anthropicKeyOptions, withClaudeCodeIdentity,
} from '@flyvendedk799/ai-auth';

const store = new MemoryCredentialStore();            // or JSON file, or Postgres
const accounts = new ClaudeAccountStore({ store, secret: process.env.SECRET_KEY! });
const keys = new ApiKeyStore({ store, secret: process.env.SECRET_KEY! });

const connected = (await accounts.status(userId)).connected;
const anthropic = new Anthropic(
  connected
    ? anthropicSubscriptionOptions(await accounts.token(userId))
    : anthropicKeyOptions((await keys.resolve('anthropic')).key!),
);

await anthropic.messages.create({
  model: 'claude-sonnet-5',
  max_tokens: 4096,
  // Required on a subscription. Harmless on a key. See trap #1.
  system: connected ? withClaudeCodeIdentity(mySystemPrompt) : mySystemPrompt,
  messages: [{ role: 'user', content: 'hello' }],
});
```

---

## The browser login

The real flow is `claude` in a shell: it prints a URL, you approve in a browser, you paste a code back. It is short, legible, and never asks anyone to handle a token — so this does not replace it with a wizard. It runs the same exchange on your server and shows it as the session it mirrors.

**Server** — mount the routes. Authentication is a function you supply, because every project has a different idea of what a signed-in user is:

```ts
import { claudeAuthRoutes } from '@flyvendedk799/ai-auth/fastify';

await app.register(claudeAuthRoutes({
  store: accounts,
  resolveAccount: async (request, reply) => {
    const user = await mySessions.current(request);
    if (!user) { reply.code(401).send({ error: 'unauthorized' }); return null; }
    return { id: user.id, label: user.email };
  },
}));
```

Returning `null` means "I have already answered" — so your app owns its own 401, its own redirect, its own shape of error body.

**Browser** — one component:

```tsx
import { ClaudeTerminal } from '@flyvendedk799/ai-auth/react';
import '@flyvendedk799/ai-auth/react/terminal.css';

<ClaudeTerminal onChange={(c) => setConnected(c?.connected ?? false)} />
```

The stylesheet reads your design tokens (`--accent`, `--border`, `--text`, …) when you have them and falls back to a complete dark palette when you do not. If you mounted the routes somewhere other than `/api/claude-code`, call `setClaudeApiPrefix` (also from `/react`) to match.

Routes: `POST {prefix}/login`, `POST {prefix}/login/complete`, `GET {prefix}`, `DELETE {prefix}`.

---

## Reading a login off the machine

For a self-hosted instance where the operator's own plan is the point:

```ts
const claude = new ClaudeCodeCredential();
if ((await claude.status()).connected) {
  const anthropic = new Anthropic(anthropicSubscriptionOptions(await claude.token()));
}

const openai = new OpenAI(codexOptions(await new CodexCredential().identity()));
```

Two rules hold throughout, and both are the opposite of what you would guess:

**Re-read, do not own.** The file belongs to the CLI. Every call re-reads it, so a sign-in, sign-out or re-auth is picked up without restarting anything.

**Refresh only when it is already dead.** These providers rotate the refresh token on exchange, so a refresh performed here would leave the *user's own CLI* holding a credential your server has already spent. Claude refreshes only once the token has genuinely expired, and keeps the result in memory. Codex never refreshes: its CLI keeps its own token current, and the answer to an expired one is "run `codex`", which costs the user nothing.

---

## Storage

Credentials go through a three-method interface, and what lands in it is already sealed — an adapter never holds a token in the clear, and writing a new one involves no decisions about cryptography.

```ts
interface CredentialStore {
  read(key: string): Promise<StoredRecord | null>;
  write(key: string, record: StoredRecord): Promise<void>;
  delete(key: string): Promise<void>;
}
```

| adapter | for |
|---|---|
| `MemoryCredentialStore` | a CLI, a test, anything that signs in and works in one run |
| `JsonFileCredentialStore` | a desktop app or single-user server. `0600`, written through a rename |
| `PostgresCredentialStore` | everything else. Ships `SCHEMA_SQL`; run it through your own migrations |

The Postgres adapter does not import `pg`. It asks for the one method it uses, which `pg.Pool` already satisfies — so you keep your own driver version and pool settings.

**Adopting this over credentials you already have?** Pass `secretLabel` with whatever label your previous code derived its key from. See [trap #5](#5-the-encryption-label-is-half-the-key).

### Encryption

AES-256-GCM, keyed from a secret you already have, stored as `iv:tag:ciphertext`. Each store passes its own label, and that separation is load-bearing: a value written by the key store must not open under the OAuth store's key, so a bug that reads the wrong row fails loudly instead of handing one subsystem another's secret.

Rotating the host secret makes stored values unreadable. That is the honest trade for not introducing a second secret to manage — and reads degrade to "not configured" rather than throwing, so recovery is a sign-in rather than a failed boot.

---

## Models, pricing, errors

```ts
import { modelsFor, pricingFor, describeProviderError, providerErrorFacts } from '@flyvendedk799/ai-auth/registry';

modelsFor('claude-code');  // lightest first, each with a tier and a note
pricingFor('claude-haiku-4-5-20251001');  // dated ids resolve to their published rate
```

`modelsFor` carries a **tier** — `light` / `balanced` / `heavy` — because a subscription meters each model on its own allowance. When the heavy one is refused, "pick a lighter one" is the fix, and a picker showing only names cannot help anyone do it.

`describeProviderError(error, provider, model, { configureAt: 'Settings' })` turns an SDK failure into a sentence someone can act on, naming where to change things if you tell it what to call that place. `providerErrorFacts(error)` gives you the raw facts — status, `retry-after`, the plan's own verdict, its utilisation — worth **storing beside a failure**, because a message alone is undiagnosable an hour later.

---

## Traps, each of these cost a day

### 1. A subscription token must say it is Claude Code

Every request on a Claude Code OAuth token must open with the CLI's identity system block. Without it, Anthropic refuses **Opus and Sonnet** with `429 rate_limit_error` — on a plan nowhere near its limit.

```ts
system: withClaudeCodeIdentity(mySystemPrompt)
```

Measured on one account, seconds apart, only the system prompt varying:

| request | |
|---|---|
| opus-5 · identity as the **first** block | **200** |
| opus-5 · identity as the *second* block | 429 |
| opus-5 · a different opening sentence | 429 |
| opus-5 · identity concatenated into the prompt | 429 |
| opus-5 · no identity | 429 |
| sonnet-5 · identity first | **200** |
| **haiku · no identity** | **200** |

Exact text, first position, its own block. All three matter.

**Haiku's exemption is the trap.** Haiku is what you reach for to test a credential — cheap, fast, harmless — and it is the one model that does not need this. A request shape that is broken for every model you want looks perfectly healthy on the one you tried. This was diagnosed twice as "the plan is rate-limited" before anyone thought to vary the system prompt on a model other than Haiku.

### 2. A 429 does not mean the plan is exhausted

It usually means *this model* is. Check `anthropic-ratelimit-unified-status` on the response: `allowed` with a 429 means a per-model limit, a burst throttle, or something between you and the provider. `providerErrorFacts` extracts it; `describeProviderError` says the right thing about it.

### 3. Every `tool_use` needs a `tool_result`

Not just the one you cared about. A message following an assistant turn that made tool calls must answer **all** of them, in that one message, or the request is refused:

```
messages.2: `tool_use` ids were found without `tool_result` blocks immediately after
```

Set `tool_choice: { type: 'tool', name, disable_parallel_tool_use: true }` so there is only ever one, and answer every id you get anyway. This only fires on a *second* message, so it hides until the first thing you send back is a correction.

### 4. `authToken`, not `apiKey`

The SDK sends `Authorization: Bearer` for the first and `x-api-key` for the second, and Anthropic validates `x-api-key` whenever the header is present. A placeholder key alongside a valid bearer is not ignored — it is rejected. `apiKey` must be `null` **explicitly**, or the SDK reads `ANTHROPIC_API_KEY` from the environment and a machine with both 401s while looking perfectly configured. `anthropicSubscriptionOptions` does this for you.

### 5. The encryption label is half the key

The key is `sha256(label + ':' + secret)`. Change the label and nothing throws — stored values simply stop decrypting, every connected account reads as disconnected, and the only symptom is people being signed out for no stated reason. Adopting this library over an existing deployment's rows means passing `secretLabel` with the old label.

### 6. Dated model ids are real ids

Vendors publish both `claude-haiku-4-5` and `claude-haiku-4-5-20251001`, and the second is the one you call. Exact-matching a pricing table sends the dated id to your unknown-model fallback — which, if that fallback is pessimistic, prices a correctly configured deployment at several times the truth. `pricingFor` resolves the suffix; `pricingKeyFor` exposes the rule.

### 7. The consent screen says Claude Code

Because that is whose client id this flow uses. Tell your users, and read Anthropic's and OpenAI's subscription terms before pointing a hosted product at consumer plans. The mechanism is sound; whether a given deployment is entitled to use it is not a question this library can answer for you.

Every OAuth constant here was read out of the installed CLIs rather than guessed, because a wrong endpoint fails as an opaque HTML page rather than as an error.

---

## Development

```
npm install
npm test        # 153 tests, no network
npm run build
```

MIT.
