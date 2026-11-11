/**
 * Automatic setup in the selected-tool dialog: one tap copies the sentence
 * a person pastes into their coding agent (docs/AGENT_REPO.md §V2.18).
 *
 * The sentence points at a static page with no user content; on an agent's
 * own page it also names that agent's id, so the setup ends with the
 * workspace pointed at it. Copying can fail (insecure origin, unfocused
 * document, permission refused); that says so and shows the text to copy by
 * hand, like CopyButton.
 */
import { useEffect, useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { notify } from './primitives';
import { HARNESSES, type Harness } from '@onmyradar/contract';

export function onboardText(agentId?: string, harness?: Harness): string {
  const base = `Fetch and execute the appropriate instructions to set me up for On My Radar from ${window.location.origin}/agent-setup/prompt.md`;
  const selected = harness ? `${base} for ${HARNESSES[harness].short}` : base;
  return agentId ? `${selected} — agent id: ${agentId}` : selected;
}

export function OnboardPill({ agentId, harness }: { agentId?: string; harness?: Harness }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2400);
    return () => clearTimeout(timer);
  }, [copied]);
  const text = onboardText(agentId, harness);
  return (
    <button
      type="button"
      className="onboard-pill min-h-11"
      title={text}
      aria-label={`Copy setup prompt${harness ? ` for ${HARNESSES[harness].short}` : ''}`}
      onClick={() =>
        void (async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            notify(`Could not copy. Paste this into your coding agent: ${text}`, 'error');
          }
        })()
      }
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
      )}
      <span aria-live="polite">
        {copied ? 'Copied — paste into your tool' : 'Copy setup prompt'}
      </span>
    </button>
  );
}
