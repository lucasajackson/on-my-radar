/**
 * A textarea that completes `@handles`.
 *
 * ## The candidate list is the point, not the convenience
 *
 * It offers exactly the people who can already read this radar — its owner, its
 * members, and a cascading topic's members — because that is the set the server
 * resolves against. A handle naming anybody else does not resolve and stays
 * plain text, so the picker is not a shortcut past a rule; it is a window onto
 * the rule. Somebody who cannot read the radar is not offered, and typing their
 * name anyway addresses nobody.
 *
 * `listMembers` already answers exactly this question, including the cascade,
 * and needs only read access — so there is no second endpoint and no second
 * definition of who is here to disagree with the first.
 *
 * ## Pulling in somebody who is not on the list
 *
 * That is a *share*, not a mention, and the composer says so rather than doing
 * either quietly. `MentionHint` below is what turns an unresolved handle into a
 * sentence with a way forward instead of silence.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  extractMentions,
  mentionHandlesFor,
  mentionKey,
  type MemberDto,
} from '@onmyradar/contract';
import { api } from '../lib/api';
import { queryKeys } from '../lib/session';

export interface MentionCandidate {
  /** Unique within one radar's candidate list. A user id, or an agent id. */
  key: string;
  name: string;
  /** The handle inserted on pick — the one least likely to be ambiguous. */
  handle: string;
  /** Every handle this principal answers to, for deciding what resolves. */
  handles: string[];
  /**
   * Whose agent this is, when it is one. Printed beside the name, because
   * "Claude" on a shared radar means nothing without it — and there may be two.
   */
  actsFor: string | null;
}

/** What to print for somebody. Mirrors `displayNameFor` on the server. */
function displayName(member: { name: string | null; email: string }): string {
  return member.name?.trim() || (member.email.split('@')[0] ?? member.email);
}

/**
 * Who can be addressed on this radar.
 *
 * Pending invitations are filtered out: an address that has never signed in has
 * no account behind it, cannot read the radar, and so cannot be resolved by the
 * server either. Offering it would promise a notification that never arrives.
 */
export function useMentionCandidates(radarId: string | null): MentionCandidate[] {
  const query = useQuery({
    queryKey: queryKeys.members(radarId ?? 'none'),
    queryFn: () => api.radars.members(radarId as string),
    enabled: Boolean(radarId),
    staleTime: 60_000,
  });

  return useMemo(() => {
    const members = query.data?.members ?? [];
    const agents = query.data?.agents ?? [];

    const people: MentionCandidate[] = members
      .filter((member: MemberDto) => !member.pending)
      .map((member: MemberDto) => ({
        key: member.userId,
        name: displayName(member),
        handle: mentionKey(member.email.split('@')[0] ?? ''),
        handles: mentionHandlesFor(member),
        actsFor: null,
      }));

    /*
      Agents are offered beside people because they answer in the same namespace
      — `@ada` can never mean a person on one radar and an agent on another, and
      the picker showing them in one list is what makes that legible.

      **Which handle gets inserted is decided here, against the whole list.** The
      bare handle is what anybody would type, but two readers can each have a
      `@claude`, and an ambiguous handle resolves to nobody — so on a radar where
      it collides the picker inserts the owner-qualified form instead. Offering
      the short one there would put a handle in the body that notifies nobody and
      renders as plain text, which reads as the app being broken rather than as
      the rule it is.
    */
    const bareCounts = new Map<string, number>();
    for (const agent of agents) {
      bareCounts.set(agent.handle, (bareCounts.get(agent.handle) ?? 0) + 1);
    }
    const agentCandidates: MentionCandidate[] = agents.map((agent) => {
      const ambiguous =
        (bareCounts.get(agent.handle) ?? 0) > 1 ||
        people.some((person) => person.handles.includes(agent.handle));
      const qualified = agent.handles.find((handle) => handle !== agent.handle);
      return {
        key: agent.id,
        name: agent.name,
        handle: ambiguous && qualified ? qualified : agent.handle,
        handles: agent.handles,
        actsFor: agent.ownerName,
      };
    });

    return [...people, ...agentCandidates].filter((candidate) => candidate.handle.length > 0);
  }, [query.data]);
}

/**
 * The handles in a draft that name nobody who can read this radar.
 *
 * Computed with the same parser the server uses, so what the composer warns
 * about and what the server ignores are the same set by construction.
 *
 * One exception, and it is about timing rather than correctness: a handle that
 * is **still being typed** is not yet wrong. Typing "@b" towards "@ben" would
 * otherwise print "@b is not on this radar" directly above an open menu offering
 * Ben — the warning and the suggestion contradicting each other, mid-keystroke.
 * So a handle is left alone while it sits at the very end of the draft and could
 * still grow into somebody's. Move the caret on, or type a word after it, and it
 * is judged like any other.
 */
export function unresolvedHandles(body: string, candidates: MentionCandidate[]): string[] {
  if (!body.includes('@')) return [];
  const known = new Set(candidates.flatMap((candidate) => candidate.handles));
  const trailing = /@([\p{L}\p{N}][\p{L}\p{N}._-]*)$/u.exec(body.trimEnd());
  const beingTyped = trailing ? mentionKey(trailing[1] ?? '') : null;

  return extractMentions(body).filter((handle) => {
    if (known.has(handle)) return false;
    if (
      handle === beingTyped &&
      [...known].some((candidate) => candidate.startsWith(handle) && candidate !== handle)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Says what will happen to a handle that resolves to nobody, and what to do
 * about it — rather than letting it fail silently at post time.
 */
export function MentionHint({
  body,
  candidates,
}: {
  body: string;
  candidates: MentionCandidate[];
}) {
  const unknown = unresolvedHandles(body, candidates);
  if (unknown.length === 0) return null;
  return (
    <p className="note mention-hint">
      {unknown.map((handle) => `@${handle}`).join(', ')}{' '}
      {unknown.length === 1 ? 'is not' : 'are not'} on this radar — that will post as plain text.
      Share the radar with them first to be able to mention them.
    </p>
  );
}

/** The token being typed at the caret, if the caret is inside one. */
function activeToken(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  // Same boundary rule as MENTION_PATTERN: start of text, a space, or a bracket.
  const match = /(?:^|[\s(])@([\p{L}\p{N}][\p{L}\p{N}._-]*)?$/u.exec(before);
  if (!match) return null;
  const query = match[1] ?? '';
  return { query, start: caret - query.length - 1 };
}

export function MentionTextarea({
  value,
  onChange,
  onSubmit,
  candidates,
  className = '',
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  /** ⌘+Enter, the one commit gesture this application uses everywhere. */
  onSubmit?: () => void;
  candidates: MentionCandidate[];
  className?: string;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [token, setToken] = useState<{ query: string; start: number } | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  const matches = useMemo(() => {
    if (!token) return [];
    const query = mentionKey(token.query);
    const pool = candidates.filter((candidate) =>
      query === ''
        ? true
        : candidate.handles.some((handle) => handle.startsWith(query)) ||
          mentionKey(candidate.name).includes(query),
    );
    return pool.slice(0, 6);
  }, [token, candidates]);

  useEffect(() => {
    setHighlighted(0);
  }, [token?.query]);

  const refreshToken = () => {
    const element = ref.current;
    if (!element) return;
    setToken(activeToken(element.value, element.selectionStart));
  };

  const pick = (candidate: MentionCandidate) => {
    const element = ref.current;
    if (!element || !token) return;
    const caret = element.selectionStart;
    const next = `${value.slice(0, token.start)}@${candidate.handle} ${value.slice(caret)}`;
    onChange(next);
    setToken(null);
    // The caret has to land after the inserted handle, and it can only be moved
    // once React has painted the new value — measured rather than assumed, which
    // is the rule this application already follows for every caret question.
    const at = token.start + candidate.handle.length + 2;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(at, at);
    });
  };

  return (
    <div className="mention-anchor">
      <textarea
        {...rest}
        ref={ref}
        className={className}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          // After the value, so the token is read from what was actually typed.
          requestAnimationFrame(refreshToken);
        }}
        onClick={refreshToken}
        onBlur={() => {
          // Late enough for a click on an option to land first.
          window.setTimeout(() => setToken(null), 120);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (token && matches.length > 0) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setHighlighted((current) => (current + 1) % matches.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlighted((current) => (current - 1 + matches.length) % matches.length);
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const chosen = matches[highlighted];
              if (chosen) {
                event.preventDefault();
                pick(chosen);
                return;
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setToken(null);
              return;
            }
          }
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && onSubmit) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />

      {token && matches.length > 0 ? (
        <ul className="mention-menu" role="listbox">
          {matches.map((candidate, index) => (
            <li key={candidate.key}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={`mention-option ${index === highlighted ? 'is-active' : ''}`}
                // pointerDown, not click: blur fires first on a click and would
                // have already closed the menu.
                onPointerDown={(event) => {
                  event.preventDefault();
                  pick(candidate);
                }}
              >
                <span className="mention-option-name">
                  {candidate.name}
                  {candidate.actsFor ? (
                    <span className="instrument" style={{ opacity: 0.65 }}>
                      {' '}
                      · via {candidate.actsFor}
                    </span>
                  ) : null}
                </span>
                <span className="instrument mention-option-handle">@{candidate.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
