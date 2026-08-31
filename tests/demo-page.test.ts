import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderDemoPage } from '../src/http/demo-page.js';

/**
 * The page's behaviour lives inside a template literal, where TypeScript cannot
 * see it — a typo there ships silently and the demo is dead on arrival. So the
 * script is parsed, and run against a stub DOM, exactly as the board's is.
 */

function scriptOf(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(match, 'the page should carry an inline script').not.toBeNull();
  return match[1]!;
}

/** Enough of a DOM for the demo: elements by id, a query over the chat, classes. */
function fakeDom(html: string) {
  const bubbles = (html.match(/class="b [^"]*"/g) ?? []).map(() => element());
  function element() {
    const classes = new Set<string>();
    return {
      textContent: '',
      innerHTML: '',
      className: '',
      offsetWidth: 1,
      children: [] as unknown[],
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        contains: (c: string) => classes.has(c),
      },
      appendChild(child: unknown) {
        this.children.push(child);
      },
      addEventListener() {},
    };
  }

  return {
    bubbles,
    document: {
      getElementById: () => element(),
      querySelectorAll: () => bubbles,
      createElement: () => element(),
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
}

describe('the public how-to-play page', () => {
for (const lang of ['en', 'hi'] as const) {
  it(`renders and runs its script (${lang})`, () => {
    const html = renderDemoPage(lang);
    const sandbox = fakeDom(html);
    new vm.Script(scriptOf(html)).runInNewContext(sandbox);

    // The four-phone view is stepped, so frame zero must already be painted.
    expect(sandbox.bubbles.length).toBeGreaterThanOrEqual(15);
  });
}

it('shows the whole journey, not just the ticket', () => {
  const html = renderDemoPage('en');
  for (const id of ['id="chat"', 'id="runChat"', 'id="s0"', 'id="s3"', 'id="dots"', 'id="ticket"']) {
    expect(html, `missing ${id}`).toContain(id);
  }
  // The handover is the point of the transcript; it must survive edits.
  expect(html).toMatch(/From here I am the host/);
  expect(html).toMatch(/Claim Middle Line/);
});

it('is safe to link publicly: no player, no game, no token', () => {
  const html = renderDemoPage('en');
  expect(html).not.toMatch(/\/public\/board\//);
  expect(html, 'no real uuids should appear').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
});
});
