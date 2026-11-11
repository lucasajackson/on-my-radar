// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SearchBox, Interpretation, withSuggestion } from './search-input';
import { must } from '../lib/must';
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it.each(['topic', 'array'])(
  'completes a negative %s alternative while preserving earlier values and keyboard selection',
  async (prefix) => {
    function Fixture() {
      const [value, setValue] = useState(`not:${prefix}:Old|Prod`);
      const input = useRef<HTMLInputElement>(null);
      return (
        <SearchBox
          value={value}
          onChange={setValue}
          inputRef={input}
          radars={[]}
          people={[]}
          topics={[{ id: 'topic-id', name: 'Product work', slug: 'product-work' }]}
        />
      );
    }
    await act(async () => root.render(<Fixture />));
    const input = must(host.querySelector('input'));
    await act(async () => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'd', bubbles: true }));
    });
    expect(host.querySelector('[role="option"]')?.textContent).toContain('Product work');
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(input.value).toBe(`not:${prefix}:Old|"Product work" `);
  },
);
it('shows explicit combination rules with query interpretation', async () => {
  await act(async () =>
    root.render(
      <Interpretation
        result={{
          filters: [
            { field: 'tag', raw: 'tag:bug|techdebt', resolved: true, label: '#bug or #techdebt' },
          ],
          problems: [],
          combinationRules: ['Negative filters intersect.'],
        }}
      />,
    ),
  );
  expect(host.querySelector('summary')?.textContent).toBe('How these filters combine');
  expect(host.querySelector('details')?.textContent).toContain('Negative filters intersect.');
});

async function typeInto(initial: string) {
  function Fixture() {
    const [value, setValue] = useState(initial);
    const input = useRef<HTMLInputElement>(null);
    return <SearchBox value={value} onChange={setValue} inputRef={input} radars={[]} people={[]} />;
  }
  await act(async () => root.render(<Fixture />));
  const input = must(host.querySelector('input'));
  await act(async () => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', bubbles: true }));
  });
  return input;
}

it('completes a half-typed has: from the values it takes', async () => {
  const input = await typeInto('rust has:li');
  const offered = Array.from(host.querySelectorAll('[role="option"]')).map((o) => o.textContent);
  expect(offered.some((text) => text.startsWith('link'))).toBe(true);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })),
  );
  expect(input.value).toBe('rust has:link ');
});

it('lets Enter search rather than complete, until the suggestions are chosen from', async () => {
  const onKeyDown = vi.fn();
  function Fixture() {
    const [value, setValue] = useState('rust is:in');
    const input = useRef<HTMLInputElement>(null);
    return (
      <SearchBox
        value={value}
        onChange={setValue}
        inputRef={input}
        radars={[]}
        people={[]}
        onKeyDown={onKeyDown}
      />
    );
  }
  await act(async () => root.render(<Fixture />));
  const input = must(host.querySelector('input'));
  await act(async () => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'n', bubbles: true }));
  });
  expect(host.querySelector('[role="option"]')).not.toBeNull();
  expect(host.querySelector('[aria-selected="true"]')).toBeNull();
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(input.value).toBe('rust is:in');
  expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }));
  expect(host.querySelector('[role="option"]')).toBeNull();
});

it('does not take Enter to complete a value already typed in full', async () => {
  await typeInto('has:link');
  expect(host.querySelector('[role="option"]')).toBeNull();
});

it("offers a misspelt closed filter's values, and swaps the chosen one in", async () => {
  const onSuggest = vi.fn();
  await act(async () =>
    root.render(
      <Interpretation
        result={{
          filters: [],
          problems: [
            { raw: '-has:lnk', message: 'has: takes link or file.', suggestions: ['link', 'file'] },
          ],
        }}
        onSuggest={onSuggest}
      />,
    ),
  );
  const buttons = Array.from(host.querySelectorAll('[role="group"] button'));
  expect(buttons.map((b) => b.textContent)).toEqual(['-has:link', '-has:file']);
  await act(async () => (buttons[0] as HTMLButtonElement).click());
  expect(onSuggest).toHaveBeenCalledWith('-has:lnk', 'link');
  expect(withSuggestion('rust -has:lnk later', '-has:lnk', 'link')).toBe('rust -has:link later');
  expect(withSuggestion('rust has:', 'has:', 'file')).toBe('rust has:file');
});
