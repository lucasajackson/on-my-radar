/**
 * The conversation around a blip: reactions, and the comment thread.
 *
 * Both live *under* the blip and both stay quiet until there is something to
 * say. That restraint is the point — this is a capture app, and a permanent row
 * of empty reaction buttons under every private note would be six pieces of
 * chrome charging rent on a surface whose whole thesis is that capture is
 * cheap. So on a blip nobody has touched, the whole thing is one hairline row of
 * instrument text; it only grows into a conversation once one exists.
 *
 * The two halves are deliberately different weights. A reaction is the cheapest
 * possible response and reads as chrome: mono, small, in the instrument voice. A
 * comment is somebody's words, so it is set in the reading serif like the blip
 * it sits under — the same ink-on-an-instrument-panel tension, one level down.
 */
import { GuestSupportRevoke } from './guest-support-revoke';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  CornerDownRight,
  MessageSquare,
  Send,
  SmilePlus,
  Trash2,
  X,
} from 'lucide-react';
import {
  BLIP_REACTIONS,
  BLIP_REACTION_KEYS,
  conversationFor,
  mentionKey,
  type BlipDto,
  type CommentDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { RelativeTime } from './relative-time';
import { renderMarkdown } from '../lib/markdown';
import { queryKeys } from '../lib/session';
import {
  MentionHint,
  MentionTextarea,
  useMentionCandidates,
  type MentionCandidate,
} from './mention-input';
import { ConfirmDialog, notify } from './primitives';
import { Byline } from './byline';
import { useLivePoll } from '../lib/polling';
import { scrollPaneTo } from '../lib/pane-scroll';

/**
 * The handle that addresses whoever wrote `reply`.
 *
 * It used to be `@` plus their display name, and a mention stops at the first
 * space — so replying to "Ada Lovelace" wrote `@Ada Lovelace`, which resolves
 * only if their handle happens to be their first name. The candidate list knows
 * the handle each person and agent actually answers to; an agent speaking in
 * its own voice is the one being answered.
 */
export function replyHandle(
  reply: CommentDto,
  candidates: readonly MentionCandidate[],
): string | null {
  const key = reply.voice === 'persona' ? reply.agent?.id : reply.author?.id;
  const known = key ? candidates.find((candidate) => candidate.key === key) : undefined;
  if (known) return known.handle;
  const fallback = mentionKey(reply.author?.email.split('@')[0] ?? '');
  return fallback || null;
}

export function Conversation({
  blip,
  template,
  commentsEnabled,
  reactionsEnabled,
  /** True on a public page: the thread is readable, nothing can be added to it. */
  readOnly = false,
  onChanged,
  /** Public pages fetch the thread through the radar's public identity. */
  publicSlug,
  startOpen = false,
  focusOnOpen = startOpen,
  ownsRadar = false,
  poll = false,
}: {
  blip: BlipDto;
  /** Decides whether the thread is the content or an aside about it. */
  template?: string | undefined;
  commentsEnabled: boolean;
  reactionsEnabled: boolean;
  readOnly?: boolean;
  onChanged?: () => void;
  publicSlug?: string;
  /** Open the thread at once, with the box focused: the caller came here to reply. */
  startOpen?: boolean;
  /** Reading surfaces may show the thread immediately without asking to write. */
  focusOnOpen?: boolean;
  /**
   * Whether the viewer owns the radar, which on a helpdesk decides what "Reply
   * to client" does: sent as written, or held for the owner's review. Only the
   * composer's hint reads it — the server decides, and the posted reply carries
   * the visibility it actually got.
   */
  ownsRadar?: boolean;
  /**
   * Refetch the thread every 15 s. Only for the one card that is open: a page of fifty
   * threads polling each would be 200 requests a minute. Lists refetch on focus alone.
   */
  poll?: boolean;
}) {
  // Read off the registry, never off a template id — the same rule the card
  // follows for its facets. A discussion radar declares its thread `expanded`
  // because there the conversation *is* the blip's content; everywhere else the
  // restraint stays, and it is deliberate rather than incidental.
  const shape = conversationFor(template);
  const [open, setOpen] = useState(shape.expanded || startOpen);
  // Opening the thread is asking to write in it, so the box takes focus. Not
  // on an expanded thread shown at rest, where nobody asked for anything.
  const [focusBox, setFocusBox] = useState(focusOnOpen);
  const [picking, setPicking] = useState(false);

  // Both features can be switched off per radar — but history never disappears.
  // A thread that vanished the moment an owner flipped a setting would read as
  // data loss rather than as a setting, so an existing conversation stays
  // readable and only the means of adding to it goes away.
  const showReactions = reactionsEnabled || blip.reactions.length > 0;
  const showComments = commentsEnabled || blip.commentCount > 0;
  if (!showReactions && !showComments) return null;

  return (
    <div className="conversation">
      <div className="conversation-bar">
        {showReactions ? (
          <ReactionRow
            blip={blip}
            canReact={reactionsEnabled && !readOnly}
            picking={picking}
            onPicking={setPicking}
            {...(onChanged ? { onChanged } : {})}
          />
        ) : null}

        {/*
          The toggle is for a thread that is folded away. Where the template
          declares the conversation `expanded` there is nothing to toggle — the
          replies are already on screen — and the count is already printed by the
          layout's own thread head. Rendering it anyway would say the same number
          twice within a few lines of itself, which is the "says it twice" rule
          the board follows inside its columns and the log follows for its lanes.
        */}
        {showComments && !shape.expanded ? (
          <button
            className="conversation-toggle instrument"
            aria-expanded={open}
            onClick={() => {
              setFocusBox(!open);
              setOpen((v) => !v);
            }}
          >
            <MessageSquare className="h-3 w-3" aria-hidden="true" />
            {blip.commentCount === 0
              ? shape.replyNoun
              : `${blip.commentCount} ${
                  blip.commentCount === 1 ? shape.replyNoun : shape.replyNounPlural
                }`}
          </button>
        ) : null}
      </div>

      {blip.external?.via === 'guest' && ownsRadar && !readOnly ? (
        <GuestSupportRevoke requestId={blip.id} />
      ) : null}
      {open && showComments ? (
        <CommentThread
          blip={blip}
          shape={shape}
          canComment={commentsEnabled && !readOnly}
          focusBox={focusBox}
          ownsRadar={ownsRadar}
          poll={poll}
          {...(onChanged ? { onChanged } : {})}
          {...(publicSlug ? { publicSlug } : {})}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------- reactions ------------------------------- */

function ReactionRow({
  blip,
  canReact,
  picking,
  onPicking,
  onChanged,
}: {
  blip: BlipDto;
  canReact: boolean;
  picking: boolean;
  onPicking: (value: boolean) => void;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // The server hands the whole tally back from the toggle, so the row can be
  // repainted from the response without waiting for a refetch — which is what
  // keeps a reaction feeling free rather than like a save.
  //
  // It remembers *which* prop it was painted over, and yields the moment a
  // different one arrives. Without that the local copy shadowed the prop for the
  // component's whole life: the card is keyed by blip id, so a refetch re-renders
  // rather than remounts, and the row would then ignore every reaction anybody
  // else added — including the very refetch `onChanged` had just asked for.
  const [local, setLocal] = useState<{
    from: BlipDto['reactions'];
    value: BlipDto['reactions'];
  } | null>(null);
  const reactions = local && local.from === blip.reactions ? local.value : blip.reactions;

  const toggle = async (reaction: string) => {
    if (!canReact || busy) return;
    setBusy(true);
    onPicking(false);
    try {
      const result = await api.blips.react(blip.id, reaction);
      setLocal({ from: blip.reactions, value: result.reactions });
      // The count on the card is derived from the same rows, so the list still
      // has to hear about it — just not before the row has already moved.
      onChanged?.();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not react to that', 'error');
    } finally {
      setBusy(false);
    }
  };

  const already = new Set(reactions.map((r) => r.reaction));

  // A popover that only closes by re-clicking its own trigger follows you down
  // the page. Escape and a click elsewhere are what everything else in this app
  // dismisses with, so the picker answers to them too.
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onPicking(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) onPicking(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [picking, onPicking]);

  return (
    <div className="reaction-row">
      {reactions.map((reaction) => (
        <button
          key={reaction.reaction}
          className={`reaction ${reaction.mine ? 'is-mine' : ''}`}
          disabled={!canReact || busy}
          aria-pressed={reaction.mine}
          // The emoji is hidden from the name, so without this a chip read as a
          // bare "1": not what it is, not whether it is yours, not what it does.
          aria-label={reactionName(reaction, canReact)}
          title={`${reaction.label}${reaction.agents ? ` — ${reaction.agents.join(', ')}` : ''}${reaction.mine ? ' — you reacted' : ''}`}
          onClick={() => void toggle(reaction.reaction)}
        >
          <span aria-hidden="true">{reaction.emoji}</span>
          <span className="instrument !tracking-normal">{reaction.count}</span>
        </button>
      ))}

      {canReact ? (
        <span className="reaction-picker-anchor" ref={anchor}>
          <button
            className="reaction is-add"
            aria-label="Add a reaction"
            aria-expanded={picking}
            disabled={busy}
            onClick={() => onPicking(!picking)}
          >
            <SmilePlus className="h-3.5 w-3.5" />
          </button>

          {picking ? (
            <span className="reaction-picker">
              {BLIP_REACTION_KEYS.filter((key) => !already.has(key)).map((key) => (
                <button
                  key={key}
                  className="reaction"
                  title={BLIP_REACTIONS[key].label}
                  aria-label={BLIP_REACTIONS[key].label}
                  onClick={() => void toggle(key)}
                >
                  <span aria-hidden="true">{BLIP_REACTIONS[key].emoji}</span>
                </button>
              ))}
              {BLIP_REACTION_KEYS.every((key) => already.has(key)) ? (
                <span className="instrument px-1.5">all used</span>
              ) : null}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** "Thumbs up, 2 reactions including yours. Remove yours." */
export function reactionName(
  reaction: { label: string; count: number; mine: boolean },
  canReact: boolean,
): string {
  const count = `${reaction.count} ${reaction.count === 1 ? 'reaction' : 'reactions'}`;
  const whose = reaction.mine ? (reaction.count === 1 ? ', yours' : ' including yours') : '';
  const action = canReact ? (reaction.mine ? ' Remove yours.' : ' Add yours.') : '';
  return `${reaction.label}, ${count}${whose}.${action}`;
}

/* -------------------------------- comments ------------------------------- */

type ConversationShape = ReturnType<typeof conversationFor>;

/**
 * A blip's thread.
 *
 * Two shapes, one component, driven by the registry. On a stream this is a flat
 * list of remarks that only appears once asked for. On a discussion radar it is
 * the content of the page: open by default, one level of nesting, and a reply
 * box that is always there.
 *
 * ## The trough, and the control that answers it
 *
 * Google Wave's documented failure was that the newest words ended up buried in
 * the middle of a long conversation with no way to find them. It *had* unread
 * navigation — a spacebar shortcut, published as a tip in a blog post — and
 * users still reported being unable to tell what was new. An affordance nobody
 * can see is not an affordance.
 *
 * So the jump to the newest reply is a visible control in the thread header
 * whenever the thread is long enough to have a trough at all, rather than a
 * hotkey or a line in a help page.
 */
function CommentThread({
  blip,
  shape,
  canComment,
  onChanged,
  publicSlug,
  focusBox = false,
  ownsRadar = false,
  poll = false,
}: {
  blip: BlipDto;
  shape: ConversationShape;
  canComment: boolean;
  onChanged?: () => void;
  publicSlug?: string;
  focusBox?: boolean;
  ownsRadar?: boolean;
  poll?: boolean;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState('');
  // Internal by default, and back to internal after every post: writing to a
  // client is an explicit act each time, never a mode the box is left in.
  const [visibility, setVisibility] = useState<'internal' | 'client'>('internal');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const newestRef = useRef<HTMLLIElement>(null);

  // Only the private surface can address anybody: a public visitor holds no
  // membership, so there is nobody they could resolve and no member list they
  // are allowed to read.
  const candidates = useMentionCandidates(publicSlug ? null : blip.radarId);

  // Paged, not truncated. The thread reads oldest-first and its cursor walks
  // *forwards*, so a page boundary hides the newest remarks — the end of the
  // conversation, which is the half people actually want. It previously said
  // "older comments not shown" and offered no way to reach them: both the copy
  // and the dead end were wrong.
  const livePoll = useLivePoll(poll && !publicSlug);
  const query = useInfiniteQuery({
    queryKey: queryKeys.comments(blip.id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      publicSlug
        ? api.publicRadars.comments(publicSlug, blip.id, pageParam)
        : api.blips.comments(blip.id, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...livePoll,
  });

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: queryKeys.comments(blip.id) });
    onChanged?.();
  };

  const add = useMutation({
    mutationFn: ({ body, parentId }: { body: string; parentId?: string }) =>
      api.blips.comment(blip.id, body, parentId, shape.visibility ? visibility : undefined),
    onSuccess: async ({ comment }) => {
      setDraft('');
      setReplyingTo(null);
      setVisibility('internal');
      // Said in words, because the outcome is the server's decision and not
      // necessarily what the switch suggested.
      if (comment.visibility === 'client_pending')
        notify('Held for the radar owner’s review — no client sees it until it is released.');
      await refresh();
    },
    onError: (err) =>
      notify(err instanceof ApiError ? err.message : 'Could not post that comment', 'error'),
  });

  // Memoised because the grouping below depends on it: a fresh array identity on
  // every render would rebuild the tree every time, and the lint rule that says
  // so is right rather than pedantic — this runs once per blip on a page of them.
  const comments = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  /*
    The server already returns the thread in reading order — each reply directly
    under the remark it answers — so this groups rather than re-sorts. Doing it
    any other way would be a second ordering rule that could disagree with the
    keyset, which is the class of bug the cursor work exists to prevent.
  */
  const roots = useMemo(() => {
    const out: { comment: CommentDto; replies: CommentDto[] }[] = [];
    const index = new Map<string, number>();
    for (const comment of comments) {
      if (comment.parentId && index.has(comment.parentId)) {
        out[index.get(comment.parentId) as number]?.replies.push(comment);
        continue;
      }
      // A reply whose parent has not been met — its parent is on a page not yet
      // fetched. Shown at the top level rather than dropped: a remark nobody can
      // see is worse than one whose indentation is briefly wrong.
      index.set(comment.id, out.length);
      out.push({ comment, replies: [] });
    }
    return out;
  }, [comments]);

  // The last thing anybody said, which is what a jump lands on.
  const newestId = comments[comments.length - 1]?.id ?? null;
  const showJump = shape.expanded && comments.length > 4;

  /*
    A jump walks to the end before it scrolls.

    It used to ask for one more page and scroll in the same breath — to the
    newest reply *loaded so far*, which on a long thread was not the newest, so
    "newest" took two presses and landed somewhere else on the first. The cursor
    walks forwards, so the end is the last page; the scroll waits for it.
  */
  const [jumping, setJumping] = useState(false);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (!jumping || isFetchingNextPage) return;
    if (hasNextPage) {
      void fetchNextPage();
      return;
    }
    if (newestRef.current) scrollPaneTo(newestRef.current, { block: 'center' });
    setJumping(false);
  }, [jumping, hasNextPage, isFetchingNextPage, fetchNextPage, newestId]);

  return (
    <div className="comment-thread">
      {showJump && newestId ? (
        <div className="thread-head">
          <span className="instrument">
            {comments.length} {comments.length === 1 ? shape.replyNoun : shape.replyNounPlural}
          </span>
          <button className="thread-jump instrument" onClick={() => setJumping(true)}>
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
            newest
          </button>
        </div>
      ) : null}

      {query.isLoading ? (
        <p className="instrument py-2">loading</p>
      ) : comments.length === 0 ? (
        <p className="instrument py-2">
          {canComment
            ? `no ${shape.replyNounPlural} yet — say the first thing`
            : `no ${shape.replyNounPlural}`}
        </p>
      ) : (
        <ul className="flex flex-col">
          {roots.map(({ comment, replies }) => (
            <Fragment key={comment.id}>
              <CommentRow
                comment={comment}
                shape={shape}
                canReply={canComment && shape.threaded}
                isNewest={comment.id === newestId}
                rowRef={comment.id === newestId ? newestRef : undefined}
                onReply={() => setReplyingTo(comment.id)}
                onChanged={() => void refresh()}
              />
              {replies.map((reply) => (
                <CommentRow
                  key={reply.id}
                  comment={reply}
                  shape={shape}
                  isReply
                  canReply={canComment && shape.threaded}
                  isNewest={reply.id === newestId}
                  rowRef={reply.id === newestId ? newestRef : undefined}
                  // Answering a reply addresses its author and lands beside it,
                  // which is what the server does with the parent id anyway.
                  onReply={() => {
                    setReplyingTo(comment.id);
                    const handle = replyHandle(reply, candidates);
                    if (handle) setDraft((current) => (current ? current : `@${handle} `));
                  }}
                  onChanged={() => void refresh()}
                />
              ))}

              {replyingTo === comment.id && canComment ? (
                <li className="comment-reply-box">
                  <Composer
                    blipId={blip.id}
                    shape={shape}
                    candidates={candidates}
                    draft={draft}
                    setDraft={setDraft}
                    pending={add.isPending}
                    visibility={shape.visibility ? visibility : null}
                    onVisibility={setVisibility}
                    ownsRadar={ownsRadar}
                    placeholder={`Reply to ${comment.author?.name ?? 'this'}…`}
                    onCancel={() => {
                      setReplyingTo(null);
                      setDraft('');
                    }}
                    onSubmit={(body) => add.mutate({ body, parentId: comment.id })}
                  />
                </li>
              ) : null}
            </Fragment>
          ))}
        </ul>
      )}

      {query.hasNextPage ? (
        <button
          className="comment-more instrument"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'loading' : `newer ${shape.replyNounPlural}`}
        </button>
      ) : null}

      {canComment && replyingTo === null ? (
        <Composer
          blipId={blip.id}
          shape={shape}
          candidates={candidates}
          draft={draft}
          setDraft={setDraft}
          pending={add.isPending}
          visibility={shape.visibility ? visibility : null}
          onVisibility={setVisibility}
          ownsRadar={ownsRadar}
          placeholder={
            shape.visibility
              ? visibility === 'client'
                ? 'Write to the client…'
                : 'Internal note — only people on this radar see it…'
              : shape.expanded
                ? 'Add to the discussion…'
                : 'Say something…'
          }
          onSubmit={(body) => add.mutate({ body })}
          autoFocus={focusBox}
        />
      ) : null}
    </div>
  );
}

/** The box itself, shared by the thread composer and every inline reply box. */
function Composer({
  blipId,
  shape,
  candidates,
  draft,
  setDraft,
  pending,
  placeholder,
  onSubmit,
  onCancel,
  autoFocus = false,
  visibility = null,
  onVisibility,
  ownsRadar = false,
}: {
  blipId: string;
  shape: ConversationShape;
  candidates: MentionCandidate[];
  draft: string;
  setDraft: (value: string) => void;
  pending: boolean;
  placeholder: string;
  /** Null where the radar has no client side; otherwise what this post will ask for. */
  visibility?: 'internal' | 'client' | null;
  onVisibility?: (value: 'internal' | 'client') => void;
  ownsRadar?: boolean;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const inputId = `comment-${blipId}`;
  useEffect(() => {
    if (autoFocus) document.getElementById(inputId)?.focus();
  }, [autoFocus, inputId]);
  // Grows with what is written, like the capture box: a reply longer than a line
  // was typed through a one-row letterbox.
  useEffect(() => {
    const field = document.getElementById(inputId);
    if (!(field instanceof HTMLTextAreaElement)) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 240)}px`;
  }, [draft, inputId]);
  const commit = () => {
    const body = draft.trim();
    if (body) onSubmit(body);
  };

  return (
    <div className={`comment-composer-wrap ${visibility === 'client' ? 'is-client' : ''}`}>
      {visibility !== null ? (
        /*
          Two states, both always visible, so which one a reply goes out as is
          read before it is sent rather than discovered after. Internal is the
          default and the left-hand choice; the client side is the accent.
        */
        <div className="composer-visibility" role="radiogroup" aria-label="Who sees this">
          <button
            type="button"
            role="radio"
            aria-checked={visibility === 'internal'}
            className="composer-visibility-option instrument"
            onClick={() => onVisibility?.('internal')}
          >
            internal note
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={visibility === 'client'}
            className="composer-visibility-option is-client instrument"
            onClick={() => onVisibility?.('client')}
          >
            reply to client
          </button>
        </div>
      ) : null}
      <div className="comment-composer">
        <label className="sr-only" htmlFor={inputId}>
          Add a {shape.replyNoun}
        </label>
        <MentionTextarea
          id={inputId}
          className="comment-input"
          rows={1}
          value={draft}
          candidates={candidates}
          placeholder={placeholder}
          onChange={setDraft}
          // ⌘+Enter everywhere it commits something — the composer, the blip
          // editor, and here. One gesture, learned once.
          onSubmit={commit}
        />
        {onCancel ? (
          <button className="btn btn-ghost p-1.5" aria-label="Cancel reply" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          className="btn btn-ghost p-1.5"
          aria-label={`Post ${shape.replyNoun}`}
          disabled={!draft.trim() || pending}
          onClick={commit}
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
      {visibility === 'client' ? (
        <p className="composer-visibility-hint instrument">
          {ownsRadar
            ? 'You own this radar, so it is released to the client as written — no review step.'
            : 'Goes to the radar owner for review. No client sees it until they release it.'}
        </p>
      ) : null}
      {/* Says what an unresolvable handle will do, before it silently does it. */}
      <MentionHint body={draft} candidates={candidates} />
    </div>
  );
}

function CommentRow({
  comment,
  shape,
  isReply = false,
  isNewest = false,
  canReply = false,
  rowRef,
  onReply,
  onChanged,
}: {
  comment: CommentDto;
  shape: ConversationShape;
  isReply?: boolean;
  isNewest?: boolean;
  canReply?: boolean;
  rowRef?: React.RefObject<HTMLLIElement | null> | undefined;
  onReply?: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const remove = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      await api.comments.remove(comment.id);
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not delete that comment', 'error');
      setBusy(false);
    }
  };

  // Releases the text on screen, by its hash: if the draft changed since this
  // row was painted, the server refuses and the refresh shows the new words.
  const release = async () => {
    if (!comment.bodySha256) return;
    setBusy(true);
    try {
      await api.comments.release(comment.id, comment.bodySha256);
      notify('Released to the client.');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not release that reply', 'error');
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const pendingReview = comment.visibility === 'client_pending';
  const toClient = comment.visibility === 'client';

  return (
    <li
      ref={rowRef}
      className={`comment ${isReply ? 'is-reply' : ''} ${isNewest ? 'is-newest' : ''} ${
        toClient ? 'is-client' : ''
      } ${pendingReview ? 'is-pending' : ''} ${busy ? 'opacity-50' : ''}`}
    >
      <div className="comment-meta">
        {/* Same component as the stream, so a remark and the blip above it can
            never disagree about whose name leads. */}
        {comment.external ? (
          /* A client's own words through the portal (T3). The name is what the
             portal asserted: shown as text, never a link, never an account. */
          <span className="truncate" data-external="portal">
            {comment.external.requesterName}
          </span>
        ) : (
          <Byline
            className="truncate"
            authorName={comment.author?.name ?? comment.author?.email.split('@')[0] ?? 'someone'}
            agent={comment.agent}
            voice={comment.voice}
          />
        )}
        <span className="instrument">
          <RelativeTime iso={comment.createdAt} />
        </span>
        {comment.editedBy ? (
          <span className="instrument min-w-0 truncate" data-facet="edited-by">
            · edited by {comment.editedBy.name ?? 'someone'}
          </span>
        ) : null}
        {comment.external ? (
          <span className="visibility-tag is-client instrument">
            client · via {comment.external.via}
          </span>
        ) : toClient ? (
          <span className="visibility-tag is-client instrument">to client</span>
        ) : pendingReview ? (
          <span className="visibility-tag is-pending instrument">draft · awaiting review</span>
        ) : null}
        {/*
          Reply and delete were two 12px glyphs touching each other at the far
          right of the row, ~500px from the words they act on, with nothing
          between the safe one and the irreversible one. They are separated by a
          rule now, drawn a little larger, and they appear on hover or focus
          rather than being painted on every reply in the thread — which is what
          stops a wall of icons down the right edge of a long discussion.
        */}
        <span className="comment-actions ml-auto">
          {canReply ? (
            <button className="btn btn-ghost p-1.5" aria-label="Reply" onClick={onReply}>
              <CornerDownRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {canReply && comment.canDelete ? <span className="row-split" aria-hidden="true" /> : null}
          {comment.canDelete ? (
            <button
              className="btn btn-ghost p-1.5 hover:text-[color:var(--danger)]"
              aria-label={`Delete ${shape.replyNoun}`}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </span>
      </div>
      <div
        className="comment-body"
        // Safe by construction: renderMarkdown escapes the source in full before
        // emitting any tags. A comment is user content from somebody who is not
        // the radar's owner, so this is the one place that matters most.
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(comment.body, {
            tagLinks: false,
            mentions: comment.mentions ?? [],
            breaks: true,
          }),
        }}
      />

      {pendingReview && comment.canRelease ? (
        <div className="release-bar">
          <span className="instrument">no client sees this until you release it</span>
          <span className="release-bar-actions">
            <button
              className="btn btn-ghost px-2.5 py-1 text-xs"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Discard
            </button>
            <button
              className="btn btn-accent px-2.5 py-1 text-xs"
              disabled={busy}
              onClick={() => void release()}
            >
              Release to client
            </button>
          </span>
        </div>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={pendingReview ? 'Discard this draft reply?' : `Delete this ${shape.replyNoun}?`}
          confirmLabel={pendingReview ? 'Discard' : 'Delete'}
          danger
          busy={busy}
          body={
            isReply || !shape.threaded
              ? 'This cannot be undone.'
              : // The one destructive act here with a consequence worth stating:
                // the replies survive, because deleting a remark must not delete
                // somebody else's answer to it.
                `Any replies to it will stay, at the top of the thread.`
          }
          onClose={() => setConfirming(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </li>
  );
}
