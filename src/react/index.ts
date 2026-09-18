/**
 * `@flyvendedk799/ai-auth/react` — the browser half.
 *
 * One component and the fetch client behind it. React is an optional peer dependency, so
 * importing this entry point is the only thing that requires it; the Node entry point does
 * not, and a server-only consumer never installs React at all.
 *
 * The stylesheet is shipped separately rather than injected, because a component that writes
 * to the document head is a component you cannot theme:
 *
 *     import '@flyvendedk799/ai-auth/react/terminal.css';
 */

export { ClaudeTerminal, type ClaudeTerminalProps } from './ClaudeTerminal.js';
export {
  claudeApiPrefix,
  claudeStatus,
  completeClaudeLogin,
  disconnectClaude,
  setClaudeApiPrefix,
  startClaudeLogin,
  type ClaudeConnection,
} from './client.js';

export { AntigravityTerminal, type AntigravityTerminalProps } from './AntigravityTerminal.js';
export {
  antigravityApiPrefix,
  antigravityStatus,
  completeAntigravityLogin,
  disconnectAntigravity,
  setAntigravityApiPrefix,
  startAntigravityLogin,
  type AntigravityConnection,
} from './client.js';
