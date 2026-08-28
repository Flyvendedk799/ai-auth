# ai-auth

Bring-your-own-credential auth for Anthropic and OpenAI.

Three ways to pay for a model call, behind one small set of pieces:

- **A Claude subscription the user signs in to, in your app.** OAuth with PKCE, the same flow `claude` runs, driven from a browser. Each account brings its own plan, so a call costs the person who asked for it rather than whoever set the server up.
- **A subscription already signed in on the machine.** If `claude` or `codex` is logged in on the box, the credential is already there. Read it, use it, never disturb it.
- **An ordinary API key.** Encrypted at rest, resolved from storage or the environment, masked for display and never readable back out.

No runtime dependencies. Node built-ins only. Fastify and React are optional peers behind their own entry points, and neither SDK is a dependency at all — see [Configuring a client](#configuring-a-client).

```
npm i github:Flyvendedk799/ai-auth
```

---

## The shortest useful example

```ts
import {
  ApiKeyStore,
  ClaudeAccountStore,
  MemoryCredentialStore,
  anthropicSubscriptionOptions,
  anthropicKeyOptions,
} from '@flyvendedk799/ai-auth';

const store = new MemoryCredentialStore();          // or JSON file, or Postgres
const accounts = new ClaudeAccountStore({ store, secret: process.env.SECRET_KEY! });
const keys = new ApiKeyStore({ store, secret: process.env.SECRET_KEY! });

// Whatever this user has: their own plan first, an API key second.
const status = await accounts.status(userId);
const options = status.connected
  ? anthropicSubscriptionOptions(await accounts.token(userId))
  : anthropicKeyOptions((await keys.resolve('anthropic')).key!);

const anthropic = new Anthropic(options);
```

---

## The browser login

The real flow is `claude` in a shell: it prints a URL, you approve in a browser, you paste a code back. It is short, legible, and never asks anyone to handle a token — so this does not replace it with a wizard. It runs the same exchange on your server and shows it as the session it mirrors.

**Server** — mount the routes. Authentication is a function you supply, because every project has a different idea of what a signed-in user is:

```ts
import { claudeAuthRoutes } from '@flyvendedk799/ai-auth/fastify';

await app.register(
  claudeAuthRoutes({
    store: accounts,
    resolveAccount: async (request, reply) => {
      const user = await mySessions.current(request);
      if (!user) { reply.code(401).send({ error: 'unauthorized' }); return null; }
      return { id: user.id, label: user.email };
    },
  }),
);
```

Returning `null` means "I have already answered" — so your app owns its own 401, its own redirect, its own shape of error body.

**Browser** — one component:

```tsx
import { ClaudeTerminal } from '@flyvendedk799/ai-auth/react';
import '@flyvendedk799/ai-auth/react/terminal.css';

<ClaudeTerminal onChange={(connection) => setConnected(connection?.connected ?? false)} />
```

The stylesheet reads your design tokens (`--accent`, `--border`, `--text`, …) when you have them and falls back to a complete dark palette when you do not. If you mounted the routes somewhere other than `/api/claude-code`, call `setClaudeApiPrefix` to match.

The four routes: `POST {prefix}/login`, `POST {prefix}/login/complete`, `GET {prefix}`, `DELETE {prefix}`.

---

## Reading a login off the machine

For a self-hosted instance where the operator's own plan is the point:

```ts
import { ClaudeCodeCredential, CodexCredential } from '@flyvendedk799/ai-auth';

const claude = new ClaudeCodeCredential();
if ((await claude.status()).connected) {
  const anthropic = new Anthropic(anthropicSubscriptionOptions(await claude.token()));
}

const codex = new CodexCredential();
const openai = new OpenAI(codexOptions(await codex.identity()));
```

Two rules hold throughout, and both are the opposite of what you would guess:

**Re-read, do not own.** The file belongs to the CLI. Every call re-reads it, so a sign-in, sign-out or re-auth is picked up without restarting anything.

**Refresh only when it is already dead.** These providers rotate the refresh token on exchange, so a refresh performed here would leave the *user's own CLI* holding a credential your server has already spent. Claude refreshes only once the token has genuinely expired, and keeps the result in memory. Codex never refreshes at all: the `codex` CLI keeps its own token current, and the answer to an expired one is "run `codex`", which costs the user nothing.

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

Three included:

| Adapter | For |
|---|---|
| `MemoryCredentialStore` | A CLI, a test, anything that signs in and does its work in one run |
| `JsonFileCredentialStore` | A desktop app or single-user server. `0600`, written through a rename |
| `PostgresCredentialStore` | Everything else. Ships `SCHEMA_SQL`; run it through your own migrations |

The Postgres adapter does not import `pg`. It asks for the one method it uses, which `pg.Pool` already satisfies unmodified — so you keep your own driver version and your own pool settings.

### Encryption

AES-256-GCM, keyed from a secret you already have, stored as `iv:tag:ciphertext`. Each store passes its own label, and that separation is load-bearing: a value written by the key store must not open under the OAuth store's key, so a bug that reads the wrong row fails loudly instead of handing one subsystem another's secret.

Rotating the host secret makes stored values unreadable. That is the honest trade for not introducing a second secret to manage — and reads degrade to "not configured" rather than throwing, so the recovery is a sign-in rather than a failed boot.

---

## Configuring a client

Neither `@anthropic-ai/sdk` nor `openai` is a dependency of this package, and neither is imported anywhere in it. The four builders return *options objects*, so you keep control of your SDK version and pay nothing for the one you do not use:

```ts
new Anthropic(anthropicKeyOptions(key));
new Anthropic(anthropicSubscriptionOptions(token));
new OpenAI(openAiKeyOptions(key));
new OpenAI(codexOptions(identity));
```

What they carry is a handful of details that are individually small and each cost a day to find out. The most expensive one:

> `authToken`, not `apiKey`. The SDK sends `Authorization: Bearer` for the first and `x-api-key` for the second, and Anthropic validates `x-api-key` whenever the header is *present*. A placeholder key alongside a valid bearer token is not ignored — it is rejected, and the request fails with "invalid x-api-key" while carrying a perfectly good credential. `apiKey` is therefore set to `null` explicitly rather than merely omitted, because omitted means the SDK reads `ANTHROPIC_API_KEY` from the environment, and a machine that has both a key and a subscription 401s on a box where everything looks correctly configured.

---

## Errors worth reading

`describeProviderError(error, provider, model)` turns an SDK failure into a sentence someone can act on, and the remedy depends on how the call was paid for. A 429 on a metered key means "you are sending too fast". The same status on a subscription means the plan's allowance is used up — often by something else entirely, because a plan is shared with every tool signed in to it, the CLI included. Those are different problems with different fixes, and one "rate limited" sends half the people who see it to the wrong one.

It returns `null` when nothing better than the raw error can be said, rather than inventing a vague catch-all.

---

## Pricing

`costOf`, `worstCaseCost` and `pricingFor` cover the models in `PRICING`, at standard published rates rather than promotional ones — under-estimating spend is the dangerous direction. An unlisted model is priced above every listed one, because a budget guard must never be the thing that discovers the table has fallen behind.

Subscription providers cost zero and every field says so. A call still spends a slice of the user's plan, but it costs your deployment nothing, and charging it the API rate would make a budget guard refuse work that is free to it.

---

## A note on subscription access

The Claude flow uses Claude Code's own public client id, so the consent screen a user sees says **Claude Code**. Anyone deploying this should tell their users that, and should read Anthropic's and OpenAI's subscription terms before pointing a hosted product at consumer plans. The mechanism is sound; whether a given deployment is entitled to use it is not a question this library can answer for you.

Every OAuth constant here was read out of the installed CLIs rather than guessed, because a wrong endpoint fails as an opaque HTML page rather than as an error.

---

## Development

```
npm install
npm test        # 119 tests, no network
npm run build
```

MIT.
