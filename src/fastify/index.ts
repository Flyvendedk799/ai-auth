/**
 * `@flyvendedk799/ai-auth/fastify` — the four routes behind the browser login.
 *
 * Fastify is an optional peer dependency, so importing this entry point is the only thing
 * that requires it; the Node entry point does not.
 */

export {
  claudeAuthRoutes,
  type ClaudeAuthAccount,
  type ClaudeAuthRoutesOptions,
} from './routes.js';
