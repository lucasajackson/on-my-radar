/** How an account download reads to a person: README, radar folders, blip files. */

/**
 * One path segment from a person's text. The archive accepts only
 * `[A-Za-z0-9_.-]`, so everything else becomes a hyphen; a leading dot would
 * make a hidden file (or `..`), so dots and hyphens are trimmed from both ends.
 */
export function pathPart(value: string, max: number): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, max)
    .replace(/[-.]+$/, '');
}

const yaml = (value: unknown) => JSON.stringify(value);
/** A text column's value; anything else (null included) reads as empty. */
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * A blip as a Markdown file: YAML front matter for what the app shows around
 * the text, then the text exactly as captured. Links are relative to the file.
 */
export function blipMarkdown(
  row: Record<string, unknown>,
  files: ReadonlyArray<{ name: string; link: string }>,
  email: { payload?: string; original?: string },
): string {
  const front: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value === null || value === undefined || value === '' || value === false) return;
    if (Array.isArray(value) && value.length === 0) return;
    front.push(`${key}: ${yaml(value)}`);
  };
  add('title', row['title']);
  add('kind', row['kind']);
  add('status', row['status']);
  add('tags', row['tags']);
  add('url', row['url']);
  add('due', row['due_at']);
  add('pinned', row['pinned']);
  add('state', row['state']);
  add('created', row['created_at']);
  add('updated', row['updated_at']);
  add('id', row['id']);
  const parts = [`---\n${front.join('\n')}\n---`, text(row['body']).trimEnd()];
  if (row['email_notes']) parts.push(`## Your notes on this email\n\n${text(row['email_notes'])}`);
  if (email.payload || email.original)
    parts.push(
      [
        '## Email',
        '',
        ...(email.original ? [`- [Original message (.eml)](<${email.original}>)`] : []),
        ...(email.payload ? [`- [Message text and details (.json)](<${email.payload}>)`] : []),
      ].join('\n'),
    );
  if (files.length)
    parts.push(
      [
        '## Attachments',
        '',
        ...files.map((file) => `- [${file.name.replace(/[[\]\\]/g, '\\$&')}](<${file.link}>)`),
      ].join('\n'),
    );
  return parts.filter(Boolean).join('\n\n') + '\n';
}

export function accountExportReadme(snapshot: Date): string {
  return `On My Radar - your account
Downloaded ${snapshot.toISOString()}

WHAT IS IN THIS FOLDER

radars/
  One folder for each radar you could read when you downloaded this.
  Every blip is a Markdown (.md) file. Open it in any text editor, or in a
  notes app that reads Markdown, such as Obsidian. The details at the top
  (tags, status, dates) are between the --- lines; the blip itself follows.
  Attached files are in each radar's files/ folder, and captured emails in
  its emails/ folder (.eml files open in most email apps).

support/
  Your support requests and the replies you were sent.

data/
  Everything again, as JSON: one file per record, in one folder per kind of
  record (comments, reactions, dashboards, agents, settings and the rest).
  This is the complete, machine-readable copy. data/export-info.json says what
  each kind of record contains and which fields were left out.

other-files/
  Stored files that are not attached to a blip (for example, uploads that
  were never finished). Only present when there are any.

manifest.json
  The size and SHA-256 checksum of every other file here. It is written last:
  if it is missing, the download did not finish and this copy is incomplete.

GOOD TO KNOW

- Radars someone else shared with you are included only while you can read
  them.
- Permanently deleted content cannot be recovered.
- Passwords, access tokens and other secrets are never included.
- This is a copy for you to keep. It cannot be imported back into On My Radar.
`;
}
