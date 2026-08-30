import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderBoardPage, renderExpiredBoardPage } from '../src/http/board-page.js';

/**
 * The board's inline script.
 *
 * It lives inside a template literal in TypeScript, so the compiler never looks
 * at it: a syntax error there compiles cleanly, passes every other test, and
 * breaks the entire board at runtime with nothing in any log. That has now
 * happened twice — once from a raw newline inside a string literal, once from a
 * local variable shadowing the translation function.
 *
 * These tests parse and run the script the way a browser would. They are cheap
 * and they close the one gap the type system structurally cannot.
 */

/** The smallest browser the script will tolerate. */
function fakeBrowser(nextState: Record<string, unknown> = {}): {
  sandbox: Record<string, unknown>;
  handlers: Record<string, Function>;
  confirms: string[];
} {
  const handlers: Record<string, Function> = {};
  const confirms: string[] = [];

  const el = (): Record<string, unknown> => ({
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    querySelector: () => el(),
    addEventListener() {},
    textContent: '',
    innerHTML: '',
    disabled: false,
  });

  const sandbox = {
    document: {
      getElementById: () => el(),
      querySelectorAll: () => [],
      documentElement: { setAttribute() {} },
      addEventListener: (name: string, fn: Function) => {
        handlers[name] = fn;
      },
    },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), location: {} },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve(nextState) }),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout() {},
    screen: { width: 400, height: 800 },
    navigator: {},
    confirm: (m: string) => {
      confirms.push(m);
      return false;
    },
    console: { log() {}, warn() {}, error() {} },
  };

  return { sandbox, handlers, confirms };
}

/**
 * Runs the board with a given state.
 *
 * The state arrives through the fetch mock rather than being assigned from
 * outside, because the script keeps everything inside a closure — assigning a
 * global of the same name reaches nothing. That mistake cost a debugging round
 * already; this comment exists so it does not cost another.
 */
async function runBoard(state?: Record<string, unknown>) {
  const html = renderBoardPage('token.signature');
  const script = html.slice(
    html.lastIndexOf('<script>') + '<script>'.length,
    html.lastIndexOf('</script>'),
  );

  const { sandbox, handlers, confirms } = fakeBrowser(state ?? {});
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  // The script calls refresh() on load; let its promise chain settle so the
  // fetched state is in place before anything is clicked.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  return { handlers, confirms, html };
}

describe('board page script', () => {
  it('parses and runs in a browser-like context', async () => {
    // A raw newline inside a string literal, an unterminated template, a stray
    // control character — all of them land here rather than on a player.
    await expect(runBoard()).resolves.toBeDefined();
  });

  it('registers a click handler', async () => {
    const { handlers } = await runBoard();
    expect(typeof handlers['click']).toBe('function');
  });

  it('the exit warning tells the truth before the game starts', async () => {
    const { handlers, confirms } = await runBoard({ status: 'lobby', called: [], grid: [], myNumbers: [], prizes: [], playerNames: [] });
    const btn = { dataset: { exit: '1' }, disabled: false };
    handlers['click']!({ target: { closest: () => btn } });

    expect(confirms).toHaveLength(1);
    // Leaving a lobby is reversible, and saying otherwise traps people in a
    // room they wanted to leave.
    expect(confirms[0]).toMatch(/join again/i);
    expect(confirms[0]).not.toMatch(/CANNOT rejoin/);
  });

  it('the exit warning is blunt once the game is running', async () => {
    const { handlers, confirms } = await runBoard({ status: 'running', called: [], grid: [], myNumbers: [], prizes: [], playerNames: [], currentSeq: 1, totalNumbers: 90 });
    const btn = { dataset: { exit: '1' }, disabled: false };
    handlers['click']!({ target: { closest: () => btn } });

    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatch(/CANNOT rejoin/);
  });

  it('carries both languages and the landscape layout', async () => {
    const { html } = await runBoard();
    expect(html).toContain('@media (orientation: landscape)');
    expect(html).toContain('हाँ, मेरे पास है');
    expect(html).toContain('data-lang=');
  });

  it('renders the expired page without the live board', () => {
    const page = renderExpiredBoardPage('That game has finished', 'Try a new one.');
    expect(page).toContain('That game has finished');
    expect(page).not.toContain('<script>');
  });
});
