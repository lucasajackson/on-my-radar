/**
 * The one copy-to-clipboard control.
 *
 * There were five, written separately, and four of them awaited
 * `navigator.clipboard.writeText` with nothing to catch it. That call rejects
 * outright on an insecure origin, when the document is not focused, and when
 * permission is refused — so on those four the button simply did nothing, on
 * the screens that show a secret exactly once. A failure now says so, and says
 * what to do instead.
 */
import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { notify } from './primitives';

export function CopyButton({
  value,
  label = 'Copy',
  className = 'btn',
  iconClassName = 'h-4 w-4',
  ariaLabel,
}: {
  value: string;
  label?: string;
  className?: string;
  iconClassName?: string;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      onClick={() =>
        void (async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            notify('Could not copy. Select the text and copy it yourself.', 'error');
          }
        })()
      }
    >
      {copied ? <Check className={iconClassName} /> : <Copy className={iconClassName} />}
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  );
}
