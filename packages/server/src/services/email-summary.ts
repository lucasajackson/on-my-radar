import type { EmailSummaryDto } from '@onmyradar/contract';
import type { blipEmails } from '../db/schema.js';

export function emailSummary(row: typeof blipEmails.$inferSelect, notes: string): EmailSummaryDto {
  return {
    subject: row.subject,
    senderName: row.senderName,
    senderAddress: row.senderAddress,
    sentAt: row.sentAt?.toISOString() ?? null,
    receivedAt: row.receivedAt.toISOString(),
    preview: row.preview,
    hasHtml: row.hasHtml,
    legacy: row.legacy,
    notes,
    attachmentCount: row.attachmentCount,
  };
}
