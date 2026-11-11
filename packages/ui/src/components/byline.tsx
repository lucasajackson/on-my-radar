/**
 * Who wrote it — and, when an agent did, who stands behind it.
 *
 * An agent writing as itself reads `architect · cosigned by Ada`, the person
 * in the human colour: a person always cosigns an agent's work
 * (docs/AGENT_REPO.md §V2.5). The rule itself is `bylineFor` in the contract,
 * so the stream and the conversation can never render it differently.
 *
 * When an agent was involved, the byline opens a small card: the agent (a link
 * only for people who can open it — a byline must never become a way to
 * discover an agent's id), whose agent it is, who cosigned this write, and for
 * a write in the person's own voice, which agent wrote it. It opens on hover
 * and on keyboard focus, and on tap — nothing here is hover-only — as a native
 * popover, so it escapes a card's clipping and gets Escape and light dismissal
 * from the browser.
 */
import { useId, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { bylineFor, type AgentDto, type Voice } from '@onmyradar/contract';

const CARD_WIDTH = 260;

function place(trigger: HTMLElement, card: HTMLElement) {
  const bounds = trigger.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - CARD_WIDTH - 8))}px`;
  const below = bounds.bottom + 6;
  card.style.top = `${below + 150 > window.innerHeight ? Math.max(8, bounds.top - 156) : below}px`;
}

const canPopover = (node: HTMLElement | null): node is HTMLElement =>
  node !== null && typeof node.showPopover === 'function';

export function Byline({
  authorName,
  agent,
  voice,
  className = '',
}: {
  authorName: string;
  agent: AgentDto | null;
  voice: Voice | null;
  className?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { lead, cosigner } = bylineFor(authorName, agent?.name ?? null, voice);

  const text = (
    <>
      {lead}
      {cosigner ? (
        <span className="byline-cosign">
          {' · cosigned by '}
          <span className="human">{cosigner}</span>
        </span>
      ) : null}
    </>
  );
  if (!agent) return <span className={`instrument byline ${className}`}>{text}</span>;

  const open = () => {
    if (closing.current) clearTimeout(closing.current);
    const node = card.current;
    if (!canPopover(node) || !trigger.current || node.matches(':popover-open')) return;
    place(trigger.current, node);
    node.showPopover();
  };
  const closeSoon = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = setTimeout(() => {
      const node = card.current;
      if (!canPopover(node) || !node.matches(':popover-open')) return;
      if (node.matches(':hover') || node.contains(document.activeElement)) return;
      node.hidePopover();
    }, 180);
  };
  const owner = agent.owner?.name?.trim();
  const human = authorName.trim() || 'Someone';

  return (
    <span className={`instrument byline ${className}`}>
      <button
        ref={trigger}
        type="button"
        className="byline-trigger"
        popoverTarget={id}
        aria-label={`${lead}${cosigner ? `, cosigned by ${cosigner}` : ''} — who wrote this`}
        onClick={() => {
          if (trigger.current && card.current) place(trigger.current, card.current);
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') open();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') closeSoon();
        }}
        onFocus={(event) => {
          // Keyboard focus opens it; a tap focuses and clicks, and the click
          // (popoverTarget) is what toggles it then.
          let keyboard = false;
          try {
            keyboard = event.currentTarget.matches(':focus-visible');
          } catch {
            keyboard = false;
          }
          if (keyboard) open();
        }}
        onBlur={closeSoon}
      >
        {text}
      </button>
      <div
        ref={card}
        id={id}
        popover="auto"
        role="dialog"
        aria-label="Who wrote this"
        className="byline-card"
        onPointerEnter={() => {
          if (closing.current) clearTimeout(closing.current);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') closeSoon();
        }}
        onBlur={closeSoon}
      >
        <span className="byline-card-agent">
          {agent.viewable ? (
            <Link to="/repo/$agentId" params={{ agentId: agent.id }}>
              {agent.name}
            </Link>
          ) : (
            agent.name
          )}
          {agent.retired ? <span className="note"> · archived</span> : null}
        </span>
        {owner ? <span className="note">{owner}’s agent</span> : null}
        <span className="note">
          Cosigned by <span className="human">{human}</span>
        </span>
        {voice === 'principal' ? (
          <span className="note">
            Written by {agent.name} in {human}’s voice
          </span>
        ) : null}
      </div>
    </span>
  );
}
