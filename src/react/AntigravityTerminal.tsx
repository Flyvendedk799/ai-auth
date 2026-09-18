/**
 * Connecting your own agy subscription, shown as the terminal it is standing in for.
 *
 * The real thing is `agy` in a shell: it prints a URL, you approve in a browser, you paste
 * a code back. That flow is genuinely good — short, legible, and it never asks anyone to
 * handle a token — so this does not replace it with a wizard. It runs the same OAuth exchange
 * on the server and *shows* it as the session it mirrors, because the shape of the thing is
 * already the clearest explanation of what is happening.
 *
 * It is a representation and it does not pretend otherwise: there is no shell on the server,
 * nothing is executed, and the only two inputs are "start" and "here is the code". Anything
 * else typed at the prompt is answered the way a shell answers an unknown command, which is
 * the honest response and keeps the metaphor from writing cheques it cannot cash.
 *
 * The credential belongs to the account that connects it, so what a person is really doing
 * here is making their own calls bill to their own plan rather than to whoever set the server
 * up.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  antigravityStatus,
  completeAntigravityLogin,
  disconnectAntigravity,
  startAntigravityLogin,
  type AntigravityConnection,
} from './client.js';

/** The part of an authorize URL worth reading: where you are being sent. */
function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}?…`;
  } catch {
    return raw;
  }
}

/**
 * Put the URL on the clipboard.
 *
 * Failure is silent on purpose: the link is right there and clickable, so a browser that
 * refuses clipboard access has cost the user nothing worth a message about.
 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard permission. The link still works.
  }
}

/** One printed line. `kind` drives colour only — the text is the whole content. */
interface Line {
  id: number;
  kind: 'command' | 'out' | 'ok' | 'warn' | 'link';
  text: string;
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'starting' }
  /** Waiting for the code. `url` is kept so it can be re-opened without restarting. */
  | { kind: 'awaiting'; url: string }
  | { kind: 'exchanging' };

export interface AntigravityTerminalProps {
  /** Reported upward so the surrounding card can restate the connection in its own terms. */
  onChange?: (connection: AntigravityConnection | null) => void;
}

export function AntigravityTerminal({ onChange }: AntigravityTerminalProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [connection, setConnection] = useState<AntigravityConnection | null>(null);
  const nextId = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const print = useCallback((kind: Line['kind'], text: string) => {
    setLines((prev) => [...prev, { id: nextId.current++, kind, text }]);
  }, []);

  // Follow the output. A terminal that does not scroll to the newest line is a terminal you
  // have to operate with two hands, and the line that matters here is always the last one.
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  const report = useCallback(
    (next: AntigravityConnection | null) => {
      setConnection(next);
      onChange?.(next);
    },
    [onChange],
  );

  // The opening banner reflects what is already true, so someone who connected last week is
  // not invited to do it again as though nothing had happened.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const status = await antigravityStatus();
        if (!live) return;
        report(status);
        if (!status.available) {
          print('warn', 'This server has no database, so a subscription cannot be stored here.');
          return;
        }
        if (status.connected) {
          print('ok', `Connected${status.plan ? ` · ${status.plan} plan` : ''}.`);
          print('out', 'Your generations are billed to this subscription.');
          print('out', 'Type `logout` to disconnect, or `agy` to sign in as someone else.');
        } else {
          print('out', 'No agy subscription is connected to this account.');
          print('out', 'Type `agy` and press Enter to sign in.');
        }
      } catch (error) {
        if (live) print('warn', (error as Error).message);
      }
    })();
    return () => {
      live = false;
    };
    // Once, on mount. Re-running this would reprint the banner over the session's own output.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, []);

  const begin = useCallback(async () => {
    setStage({ kind: 'starting' });
    print('out', 'Starting sign-in…');
    try {
      const started = await startAntigravityLogin();
      setStage({ kind: 'awaiting', url: started.url });
      print('out', 'Open this URL and approve the request:');
      print('link', started.url);
      print('out', 'Then paste the code it gives you and press Enter.');
    } catch (error) {
      setStage({ kind: 'idle' });
      print('warn', (error as Error).message);
    }
  }, [print]);

  const finish = useCallback(
    async (code: string) => {
      setStage({ kind: 'exchanging' });
      print('out', 'Exchanging code…');
      try {
        const status = await completeAntigravityLogin(code);
        report(status);
        setStage({ kind: 'idle' });
        print('ok', `Signed in${status.plan ? ` · ${status.plan} plan` : ''}.`);
        print('out', 'Generations from this account now bill to your subscription.');
      } catch (error) {
        const message = (error as Error).message;
        // A dead code cannot be retried, so the session goes back to the start rather than
        // leaving someone pasting the same string at a prompt that will never accept it.
        const restart = /expired|already been used|different login/i.test(message);
        setStage(restart ? { kind: 'idle' } : (previous) => previous);
        print('warn', message);
        if (restart) print('out', 'Type `agy` to start again.');
      }
    },
    [print, report],
  );

  const disconnect = useCallback(async () => {
    print('out', 'Disconnecting…');
    try {
      report(await disconnectAntigravity());
      setStage({ kind: 'idle' });
      print('ok', 'Disconnected. This account no longer has a subscription attached.');
    } catch (error) {
      print('warn', (error as Error).message);
    }
  }, [print, report]);

  const submit = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (value.length === 0) return;
      setInput('');
      print('command', value);

      if (stage.kind === 'awaiting') {
        // At this prompt anything is a code except the two words that mean "stop".
        if (/^(cancel|exit|q)$/i.test(value)) {
          setStage({ kind: 'idle' });
          print('out', 'Cancelled.');
          return;
        }
        await finish(value);
        return;
      }

      const command = value.toLowerCase();
      if (command === 'agy' || command === 'agy login' || command === 'login') {
        await begin();
        return;
      }
      if (command === 'logout' || command === 'agy logout' || command === 'disconnect') {
        await disconnect();
        return;
      }
      if (command === 'status' || command === 'agy status') {
        const status = await antigravityStatus();
        report(status);
        print(
          status.connected ? 'ok' : 'out',
          status.connected
            ? `Connected${status.plan ? ` · ${status.plan} plan` : ''}${status.expired ? ' · token expired, will refresh on next use' : ''}`
            : 'Not connected.',
        );
        return;
      }
      if (command === 'clear') {
        setLines([]);
        return;
      }
      if (command === 'help' || command === '?') {
        print('out', 'agy — sign in    logout — disconnect    status — check    clear — clear');
        return;
      }

      // The honest answer. Pretending to be a shell that runs anything would be a lie the
      // first time somebody typed `ls`.
      print('warn', `${value}: not something this terminal runs. Try \`agy\`, \`logout\` or \`status\`.`);
    },
    [stage, begin, finish, disconnect, print, report],
  );

  const busy = stage.kind === 'starting' || stage.kind === 'exchanging';
  const prompt = stage.kind === 'awaiting' ? 'paste code >' : '$';

  return (
    <div className="ai-auth-term" onClick={() => field.current?.focus()}>
      <div className="ai-auth-term__bar">
        <span className="ai-auth-term__dot" aria-hidden="true" />
        <span className="ai-auth-term__dot" aria-hidden="true" />
        <span className="ai-auth-term__dot" aria-hidden="true" />
        <span className="ai-auth-term__title">
          agy — {connection?.connected ? `signed in${connection.plan ? ` (${connection.plan})` : ''}` : 'not signed in'}
        </span>
      </div>

      {/* A log, announced politely: the interesting events here arrive without the user
          having done anything since their last keystroke. */}
      <div className="ai-auth-term__body" ref={scroller} role="log" aria-live="polite" aria-label="Sign-in session">
        {lines.map((line) =>
          line.kind === 'link' ? (
            <p key={line.id} className="ai-auth-term__line ai-auth-term__line--link">
              {/* Shown as its origin and path rather than in full. The href is the whole thing,
                  and so is what Copy puts on the clipboard — but four hundred characters of
                  PKCE challenge wrapped over six lines is not something anyone reads, and it
                  buries the one part that is worth checking: which host you are about to
                  approve at. */}
              <a href={line.text} target="_blank" rel="noreferrer noopener" title={line.text}>
                {shortUrl(line.text)}
              </a>
              <button type="button" className="ai-auth-term__copy" onClick={() => void copyText(line.text)}>
                copy
              </button>
            </p>
          ) : (
            <p key={line.id} className={`ai-auth-term__line ai-auth-term__line--${line.kind}`}>
              {line.kind === 'command' ? `$ ${line.text}` : line.text}
            </p>
          ),
        )}
        {busy && <p className="ai-auth-term__line ai-auth-term__line--out">…</p>}
      </div>

      {/* A div, not a form, and that is load-bearing rather than stylistic: this terminal is
          rendered *inside* the settings form, and a nested form is invalid HTML whose submit
          event bubbles to its parent — so pressing Enter to paste a code would also have saved
          the provider settings. Enter is handled on the input instead. */}
      <div className="ai-auth-term__prompt">
        <label className="ai-auth-term__sigil" htmlFor="antigravity-terminal-input">
          {prompt}
        </label>
        <input
          id="antigravity-terminal-input"
          ref={field}
          className="ai-auth-term__input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            // Stopped as well as prevented: an un-prevented Enter in a text input inside a
            // form is a request to submit that form, and the form here is the settings one.
            event.preventDefault();
            event.stopPropagation();
            void submit(input);
          }}
          disabled={busy}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={stage.kind === 'awaiting' ? 'paste the code from the approval page' : 'agy'}
          aria-label={stage.kind === 'awaiting' ? 'Authorization code' : 'Command'}
        />
      </div>
    </div>
  );
}
