// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { AttachmentDto } from '@onmyradar/contract';
import { Lightbox } from './lightbox';
import { Modal } from './primitives';

const photo = {
  id: 'a1',
  filename: 'photo.jpg',
  href: '/api/attachments/a1',
  contentType: 'image/jpeg',
} as AttachmentDto;

it('is its own top layer: Escape closes the photo, not the dialog it was opened from', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const closeDialog = vi.fn();
  const closePhoto = vi.fn();
  const render = () =>
    root.render(
      <Modal title="Linked blip" onClose={closeDialog}>
        <p>A blip with a photo</p>
        <Lightbox
          images={[photo]}
          startAt={0}
          onClose={() => {
            closePhoto();
          }}
        />
      </Modal>,
    );
  await act(async () => render());
  const close = document.querySelector<HTMLButtonElement>('.lightbox button[aria-label="Close"]');
  expect(document.activeElement).toBe(close);

  // A parent render hands over a new close callback; focus must stay put.
  await act(async () => render());
  expect(document.activeElement).toBe(close);

  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  expect(closePhoto).toHaveBeenCalledOnce();
  expect(closeDialog).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  host.remove();
});
