// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { scrollPaneTo } from './pane-scroll';

function rect(top: number, height: number): DOMRect {
  return {
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

test('scrolls the nearest scrolling ancestor by the target offset less its scroll margin, and nothing else', () => {
  document.body.innerHTML =
    '<div id="shell" style="overflow:hidden"><div id="pane" style="overflow-y:auto"><h2 id="day" style="scroll-margin-top:12px"></h2></div></div>';
  const shell = document.getElementById('shell') as HTMLElement;
  const pane = document.getElementById('pane') as HTMLElement;
  const day = document.getElementById('day') as HTMLElement;
  pane.scrollTop = 100;
  pane.getBoundingClientRect = () => rect(50, 800);
  day.getBoundingClientRect = () => rect(450, 20);
  const calls: unknown[] = [];
  pane.scrollTo = (arg: unknown) => calls.push(arg);
  let shellCalls = 0;
  shell.scrollTo = () => shellCalls++;
  day.scrollIntoView = () => shellCalls++;

  scrollPaneTo(day);

  expect(calls).toEqual([{ top: 100 + (450 - 50) - 12, behavior: 'smooth' }]);
  expect(shellCalls).toBe(0);
});

test('with no scrolling ancestor (a public page: the document scrolls) it falls back to scrollIntoView', () => {
  document.body.innerHTML = '<div><h2 id="day"></h2></div>';
  const day = document.getElementById('day') as HTMLElement;
  const calls: unknown[] = [];
  day.scrollIntoView = (arg: unknown) => calls.push(arg);

  scrollPaneTo(day, { block: 'center' });

  expect(calls).toEqual([{ block: 'center', behavior: 'smooth' }]);
});
