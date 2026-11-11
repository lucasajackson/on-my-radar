/**
 * How a blip's files are shown.
 *
 * The rule that used to be here was one line — `max-h-80 object-cover` — and it
 * was wrong for the commonest case in the product. A phone photo is portrait;
 * `object-cover` into a fixed landscape box centre-crops it, which on a picture
 * of a cat removes the cat. A crop that can lose the subject is not a crop, it
 * is a bug with a CSS property for a name.
 *
 * So:
 *
 * - **One image is shown whole.** Its own aspect ratio is reserved from the
 *   stored dimensions, so the card does not jump as it decodes, and it is capped
 *   by height rather than cropped. Nothing is ever cut off.
 * - **Several images become a contact sheet** — uniform square tiles, which *is*
 *   a deliberate crop, and reads as one because every tile is cropped the same
 *   way. The full picture is one click away in the lightbox.
 * - **Dimensions may be missing** on anything captured before they were
 *   measured. That degrades to a bounded, still-uncropped box rather than to a
 *   broken layout.
 *
 * What is *new* here is the treatment axis, and it settles the second half of
 * the same complaint. Whether a picture is a thumbnail, an inline illustration
 * or the point of the post is a property of the radar's template, so this
 * component is told which — it never works it out from a density flag that
 * happened to be nearby. See `PhotoTreatment` in the contract.
 */
import { useState, type CSSProperties } from 'react';
import { FileText, Images } from 'lucide-react';
import type { AttachmentDto, PhotoTreatment } from '@onmyradar/contract';
import { fileSize } from '../lib/format';
import { Lightbox } from './lightbox';

/** Height cap per treatment. See `PhotoTreatment` in the contract for what each means. */
const PHOTO_MAX: Record<PhotoTreatment, string> = {
  thumb: '11rem',
  inline: '30rem',
  feature: '30rem',
};

export function BlipAttachments({
  attachments,
  treatment = 'inline',
}: {
  attachments: AttachmentDto[];
  /**
   * Read off the radar template by the card. Never a boolean: the flag this
   * replaced was `compact`, which also meant "drop the kind badge", and the
   * microblog turned that on to lose the badge and silently got an 11rem
   * thumbnail with it.
   */
  treatment?: PhotoTreatment;
}) {
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);
  const images = attachments.filter((a) => a.contentType.startsWith('image/'));
  const others = attachments.filter((a) => !a.contentType.startsWith('image/'));
  if (attachments.length === 0) return null;

  const single = images.length === 1 ? images[0] : null;

  return (
    <>
      {single ? (
        <button
          type="button"
          className={`photo-single mt-2.5 ${treatment === 'feature' ? 'is-feature' : ''}`}
          onClick={() => setLightboxAt(0)}
          aria-label={`Open ${single.filename}`}
          style={{ '--photo-max': PHOTO_MAX[treatment] } as CSSProperties}
        >
          <img
            src={single.href}
            alt={single.filename}
            loading="lazy"
            /*
             * The intrinsic size as HTML attributes, not as a CSS aspect-ratio
             * on the frame. The browser uses these to reserve the right shape
             * before the bytes arrive — the same anti-reflow guarantee — while
             * leaving the box free to shrink to the picture. Putting the ratio
             * on a full-width frame instead reserved a 100%-wide box and then
             * letterboxed a portrait photo inside two grey bars.
             */
            {...(single.width && single.height
              ? { width: single.width, height: single.height }
              : {})}
          />
        </button>
      ) : images.length > 1 ? (
        <div className={`photo-sheet mt-2.5 ${treatment === 'thumb' ? 'is-compact' : ''}`}>
          {images.map((image, at) => (
            <button
              key={image.id}
              type="button"
              className="photo-tile"
              onClick={() => setLightboxAt(at)}
              aria-label={`Open ${image.filename}`}
            >
              <img src={image.href} alt={image.filename} loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}

      {images.length > 1 && treatment !== 'thumb' ? (
        <p className="instrument mt-1.5 flex items-center gap-1.5">
          <Images className="h-3 w-3" aria-hidden="true" />
          {images.length} photos · click to view
        </p>
      ) : null}

      {others.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {others.map((file) => (
            <a
              key={file.id}
              href={`${file.href}?download=1`}
              className="flex items-center gap-1.5 rounded-lg border border-[color:var(--line)] px-2 py-1 text-[12.5px] hover:border-[color:var(--accent-from)]"
            >
              <FileText className="h-3.5 w-3.5 opacity-60" />
              <span className="max-w-[12rem] truncate">{file.filename}</span>
              <span className="instrument !tracking-normal">{fileSize(file.size)}</span>
            </a>
          ))}
        </div>
      ) : null}

      {lightboxAt !== null ? (
        <Lightbox images={images} startAt={lightboxAt} onClose={() => setLightboxAt(null)} />
      ) : null}
    </>
  );
}
