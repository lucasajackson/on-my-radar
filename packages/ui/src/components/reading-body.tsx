import { useId, useRef, useState } from 'react';
import { plainText } from '../lib/markdown';
import { useInAppLinkClick } from '../lib/in-app-links';

/** Keep a reading queue scannable without hiding links inside a clipped article. */
export function ReadingBody({
  body,
  html,
  collapsible,
}: {
  body: string;
  /** HTML produced by the escaping Markdown renderer. */
  html: string;
  collapsible: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const canCollapse = collapsible && body.length > 800;
  const followLink = useInAppLinkClick();
  return (
    <div ref={container} className="reading-body mt-1.5" onClick={followLink}>
      {canCollapse && !expanded ? (
        <p id={id} className="blip-body">
          {plainText(body, 360)}
        </p>
      ) : (
        <div id={id} className="blip-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {canCollapse ? (
        <button
          type="button"
          className="reading-body-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            setExpanded(!expanded);
            if (expanded)
              requestAnimationFrame(() => {
                if ((container.current?.getBoundingClientRect().top ?? 0) < 0) {
                  container.current?.scrollIntoView({ block: 'start' });
                }
              });
          }}
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      ) : null}
    </div>
  );
}
