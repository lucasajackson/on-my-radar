import { LIMITS } from '@onmyradar/contract';

/**
 * What one captured email may carry. Dependency-light, because the parser
 * worker thread imports it.
 *
 * Attachments and inline images are counted apart. A person attaches a few
 * files; a newsletter embeds dozens of images its HTML shows by `cid:`, and one
 * shared ceiling of twelve used to refuse the whole newsletter. Inline images
 * therefore get their own count and byte budget, and those past the budget are
 * left out (the reader shows their alt text) rather than refusing the message.
 * `parts` is the abuse cap: past it the message is refused outright.
 */
export const EMAIL_LIMITS = {
  attachments: LIMITS.attachmentsPerBlip,
  inlineImages: 48,
  inlineImageBytes: 6 * 1024 * 1024,
  parts: 100,
} as const;

/** The most files one captured email can store. */
export const EMAIL_MAX_STORED_FILES = EMAIL_LIMITS.attachments + EMAIL_LIMITS.inlineImages;

/** Keeps inline images, in order, while they fit their count and byte budget. */
export function withinInlineBudget<T extends { inline: boolean; bytes: Uint8Array }>(
  files: T[],
): T[] {
  let count = 0;
  let bytes = 0;
  return files.filter((file) => {
    if (!file.inline) return true;
    if (
      count >= EMAIL_LIMITS.inlineImages ||
      bytes + file.bytes.byteLength > EMAIL_LIMITS.inlineImageBytes
    )
      return false;
    count += 1;
    bytes += file.bytes.byteLength;
    return true;
  });
}
