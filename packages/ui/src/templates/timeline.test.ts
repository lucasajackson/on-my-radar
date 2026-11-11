import { expect, it } from 'vitest';
import type { AttachmentDto, BlipDto } from '@onmyradar/contract';
import { timelineGroups, timelinePhotos } from './timeline';

const post = (id: string, createdAt: string, pinned = false) =>
  ({ id, createdAt, pinned }) as BlipDto;

it('puts pinned posts under their own heading, so no day is headed twice', () => {
  // The server's order: pinned first, then newest first.
  const monday = '2026-09-21T12:00:00';
  const blips = [
    post('pinned-monday', monday, true),
    post('wednesday', '2026-09-23T12:00:00'),
    post('tuesday', '2026-09-22T12:00:00'),
    post('monday', monday),
  ];
  const groups = timelineGroups(blips, true);
  expect(groups.map((g) => g.items.map((b) => b.id))).toEqual([
    ['pinned-monday'],
    ['wednesday'],
    ['tuesday'],
    ['monday'],
  ]);
  expect(groups[0]?.day).toBe('Pinned');
  const days = groups.map((g) => g.day);
  expect(new Set(days).size).toBe(days.length);
  const keys = groups.map((g) => g.key);
  expect(new Set(keys).size).toBe(keys.length);
});

it('collects the pictures of the posts, in feed order, and leaves other files out', () => {
  const file = (id: string, contentType: string) => ({ id, contentType }) as AttachmentDto;
  const blips = [
    { id: 'a', attachments: [file('a1', 'image/png'), file('a2', 'application/pdf')] },
    { id: 'b', attachments: [] },
    { id: 'c', attachments: [file('c1', 'image/jpeg')] },
  ] as unknown as BlipDto[];
  expect(timelinePhotos(blips).map((photo) => photo.id)).toEqual(['a1', 'c1']);
});
