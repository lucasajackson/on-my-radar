// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LATEST_TOAST_ACTION, afterLaneMove, focusWhenPresent, neighbourCard } from './focus';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 16),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const button = (id: string) => {
  const element = document.createElement('button');
  element.id = id;
  document.body.append(element);
  return element;
};

it('follows a control through both losses of a lane move: disabled, then remounted', () => {
  const before = button('lane');
  before.focus();
  focusWhenPresent(['#lane'], { frames: 30, onlyIfLost: true });
  before.blur(); // disabled while saving: focus falls to the body...
  vi.advanceTimersByTime(16 * 2);
  expect(document.activeElement).toBe(before); // ...and is rescued onto it
  before.remove(); // then the refetch unmounts it in this lane
  const after = button('lane'); // and mounts it in the new one
  vi.advanceTimersByTime(16 * 3);
  expect(document.activeElement).toBe(after);
});

it('never takes focus from somewhere a person put it', () => {
  const field = document.createElement('input');
  document.body.append(field);
  field.focus();
  button('heading');
  focusWhenPresent(['#heading'], { frames: 10, onlyIfLost: true });
  vi.advanceTimersByTime(16 * 12);
  expect(document.activeElement).toBe(field);
});

it('focuses a heading without scrolling to it, whatever the caller asked', () => {
  const heading = document.createElement('h1');
  heading.id = 'title';
  document.body.append(heading);
  const focus = vi.spyOn(heading, 'focus');
  focusWhenPresent(['#title']);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  const control = button('control');
  const focusControl = vi.spyOn(control, 'focus');
  focusWhenPresent(['#control']);
  expect(focusControl).toHaveBeenCalledWith({ preventScroll: false });
});

it('passes over an inert twin behind a dialog for the copy that can take focus', () => {
  const page = document.createElement('div');
  page.inert = true;
  const behind = document.createElement('button');
  behind.className = 'edit';
  page.append(behind);
  const dialog = document.createElement('div');
  const inDialog = document.createElement('button');
  inDialog.className = 'edit';
  dialog.append(inDialog);
  document.body.append(page, dialog);
  const tried = vi.spyOn(behind, 'focus');
  focusWhenPresent(['.edit']);
  expect(tried).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(inDialog);
});

it('looks only where it is told to', () => {
  const outside = document.createElement('button');
  outside.className = 'target';
  const scope = document.createElement('section');
  const inside = document.createElement('button');
  inside.className = 'target';
  scope.append(inside);
  document.body.append(outside, scope);
  focusWhenPresent(['.target'], { within: () => scope });
  expect(document.activeElement).toBe(inside);
});

it('finds the card that takes a moved card’s place in its own lane', () => {
  document.body.innerHTML = `
    <div class="board-column"><article data-blip-id="a"></article><article data-blip-id="b"></article></div>
    <div class="board-column"><article data-blip-id="c"></article></div>`;
  expect(neighbourCard('a')).toBe('b');
  expect(neighbourCard('b')).toBe('a');
  // Alone in its lane: nobody takes its place, and another lane's card is not it.
  expect(neighbourCard('c')).toBeNull();
  expect(afterLaneMove('c', null)).toContain(LATEST_TOAST_ACTION);
});
