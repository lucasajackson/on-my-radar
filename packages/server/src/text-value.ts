/**
 * A field that should be text, read from something that does not promise it:
 * a parsed form (whose values may be `File`s) or an outbox payload (jsonb).
 *
 * `String(value ?? '')` turned a file or an object into "[object File]" /
 * "[object Object]" and carried on as though that were the value. A string
 * comes back as itself, a finite number as its decimal form, anything else as
 * '' — which every caller already treats as "missing".
 */
export function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}
