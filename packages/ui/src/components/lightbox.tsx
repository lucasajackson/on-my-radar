/**
 * The image lightbox.
 *
 * Clicking a photo used to open the attachment route in a new tab, which 302s
 * to a presigned object URL — so what you actually got was a bare S3 address in
 * the address bar, out of the application entirely, and a back button as the
 * only way home. A picture in a blip is part of the blip; looking at it properly
 * should not mean leaving.
 *
 * It is deliberately plain: the image at its true size within the viewport, on a
 * near-black ground, with the instrument voice reduced to a filename and a
 * position. No zoom, no pan, no chrome over the picture — the ink half of the
 * design at full strength, which is the same argument the timeline makes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import type { AttachmentDto } from '@onmyradar/contract';
import { isolateModal } from '../lib/modal-isolation';

/**
 * Above any dialog. A photo opened from a blip inside a dialog (a linked blip,
 * a search preview) is the topmost layer, so the dialog underneath stops
 * answering Escape and stops pulling focus back into itself.
 */
const LIGHTBOX_DEPTH = 1_000;

export function Lightbox({
  images,
  startAt,
  onClose,
}: {
  images: AttachmentDto[];
  startAt: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startAt);
  const count = images.length;

  // Wrapping rather than stopping at the ends: with two or three photos on a
  // blip, running off the end and having nothing happen reads as broken.
  const go = useCallback(
    (delta: number) => setIndex((current) => (current + delta + count) % count),
    [count],
  );

  const panel = useRef<HTMLDivElement>(null);
  // The caller's close is an inline arrow, new on every render. Depending on it
  // re-ran the whole effect on each parent render: focus went back to the
  // opener and then jumped to Close, and the body's overflow flickered.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    // Where focus was before the overlay opened, so it can be put back. Losing
    // it sends a keyboard user to the top of the document on close — and the
    // thing they were looking at was somewhere down a long stream.
    const opener = document.activeElement as HTMLElement | null;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key === 'ArrowRight') go(1);
      if (event.key === 'ArrowLeft') go(-1);
      if (event.key !== 'Tab') return;

      // `aria-modal` tells a screen reader the rest of the page is inert; it
      // does not stop Tab walking out into it. Without the wrap, two presses
      // put focus on the page behind an opaque overlay — visibly nowhere.
      const focusable = panel.current?.querySelectorAll<HTMLElement>('a[href], button');
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const releaseIsolation = panel.current
      ? isolateModal(panel.current, LIGHTBOX_DEPTH)
      : () => undefined;
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll under the overlay — on a phone that is the
    // difference between a viewer and a hole punched through the page.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Into the dialog, not left behind on the page underneath.
    panel.current?.querySelector<HTMLElement>('button')?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      releaseIsolation();
      document.body.style.overflow = previous;
      opener?.focus();
    };
  }, [go]);

  const image = images[index];
  if (!image) return null;

  // Portaled, so it is a layer of its own rather than a child of whatever card
  // or dialog it was opened from — the isolation above makes everything else in
  // <body> inert, which would include the lightbox itself if it lived there.
  return createPortal(
    <div
      className="lightbox"
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={image.filename}
      onMouseDown={(event) => {
        // Only a click on the ground itself closes; a click that started on the
        // picture and drifted must not.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lightbox-bar">
        <span className="instrument truncate">
          {image.filename}
          {count > 1 ? ` · ${index + 1} / ${count}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <a
            className="btn btn-ghost p-2"
            href={`${image.href}?download=1`}
            title="Download"
            aria-label="Download"
          >
            <Download className="h-4 w-4" />
          </a>
          <button className="btn btn-ghost p-2" onClick={onClose} aria-label="Close">
            <X className="h-4.5 w-4.5" />
          </button>
        </div>
      </div>

      <div
        className="lightbox-stage"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {count > 1 ? (
          <button className="lightbox-step" onClick={() => go(-1)} aria-label="Previous image">
            <ChevronLeft className="h-6 w-6" />
          </button>
        ) : null}

        <img
          key={image.id}
          src={image.href}
          alt={image.filename}
          className="lightbox-image"
          {...(image.width && image.height ? { width: image.width, height: image.height } : {})}
        />

        {count > 1 ? (
          <button className="lightbox-step" onClick={() => go(1)} aria-label="Next image">
            <ChevronRight className="h-6 w-6" />
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
