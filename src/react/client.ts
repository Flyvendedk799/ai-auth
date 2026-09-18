/**
 * The account's own Claude subscription, over HTTP.
 *
 * Write-only in the direction that matters: a code goes up, a status comes back, and no token
 * ever crosses to the browser. The server holds the PKCE verifier for the duration of a login
 * and the credential afterwards, so there is nothing here worth stealing and nothing this
 * module could leak if it tried.
 */

export interface ClaudeConnection {
  connected: boolean;
  plan: string | null;
  /** Unix ms, or null when nothing is connected. */
  expiresAt: number | null;
  /** True when the access token has aged out. Not a failure — it refreshes on next use. */
  expired: boolean;
  scopes: string[];
  /** False when the server has no database and therefore nowhere to keep a credential. */
  available: boolean;
}

/**
 * Where the routes were mounted.
 *
 * The Fastify plugin takes a `prefix`, so this has to as well, or the two agree only by
 * coincidence and disagree the first time somebody namespaces their API.
 */
export let claudeApiPrefix = '/api/claude-code';

export function setClaudeApiPrefix(prefix: string): void {
  claudeApiPrefix = prefix.replace(/\/$/, '');
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${claudeApiPrefix}${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function describe(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function claudeStatus(): Promise<ClaudeConnection> {
  const response = await call('GET', '');
  if (!response.ok) throw new Error(await describe(response));
  return (await response.json()) as ClaudeConnection;
}

export async function startClaudeLogin(): Promise<{ url: string; expiresInSeconds: number }> {
  const response = await call('POST', '/login');
  if (!response.ok) throw new Error(await describe(response));
  return (await response.json()) as { url: string; expiresInSeconds: number };
}

export async function completeClaudeLogin(code: string): Promise<ClaudeConnection> {
  const response = await call('POST', '/login/complete', { code });
  if (!response.ok) throw new Error(await describe(response));
  return { ...((await response.json()) as ClaudeConnection), available: true };
}

export async function disconnectClaude(): Promise<ClaudeConnection> {
  const response = await call('DELETE', '');
  if (!response.ok) throw new Error(await describe(response));
  return (await response.json()) as ClaudeConnection;
}
export interface AntigravityConnection {
  connected: boolean;
  plan: string | null;
  projectId: string | null;
  expiresAt: number | null;
  expired: boolean;
  available: boolean;
}

export let antigravityApiPrefix = '/api/antigravity';

export function setAntigravityApiPrefix(prefix: string): void {
  antigravityApiPrefix = prefix.replace(/\/$/, '');
}

async function callAg(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${antigravityApiPrefix}${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function antigravityStatus(): Promise<AntigravityConnection> {
  const response = await callAg('GET', '');
  if (!response.ok) throw new Error(await describe(response));
  return (await response.json()) as AntigravityConnection;
}

export async function startAntigravityLogin(): Promise<{ url: string; expiresInSeconds: number }> {
  const response = await callAg('POST', '/login');
  if (!response.ok) throw new Error(await describe(response));
  return (await response.json()) as { url: string; expiresInSeconds: number };
}

export async function completeAntigravityLogin(code: string): Promise<AntigravityConnection> {
  const response = await callAg('POST', '/login/complete', { code });
  if (!response.ok) throw new Error(await describe(response));
  return { ...((await response.json()) as AntigravityConnection), available: true };
}

export async function disconnectAntigravity(): Promise<AntigravityConnection> {
  const response = await callAg('DELETE', '');
  if (!response.ok) throw new Error(await describe(response));
  return (await response.json()) as AntigravityConnection;
}

export async function setAntigravityProject(projectId: string | null): Promise<AntigravityConnection> {
  const response = await callAg('PUT', '', { projectId });
  if (!response.ok) throw new Error(await describe(response));
  return (await response.json()) as AntigravityConnection;
}
