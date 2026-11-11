/**
 * Questions an agent (or a person) asked you to decide on this card.
 *
 * Shown above the conversation of an opened card. An open question you were asked is answered
 * right here: one tap per option, or a line of your own where the options are only suggestions.
 * Where the radar's template decides, an option moves the card, so its label says what it does.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleHelp } from 'lucide-react';
import type { DecisionRequestDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { useLivePoll } from '../lib/polling';
import { notify } from './primitives';

function Request({
  request,
  onAnswer,
  busy,
}: {
  request: DecisionRequestDto;
  onAnswer: (answer: string) => void;
  busy: boolean;
}) {
  const [text, setText] = useState('');
  const open = request.status === 'open';
  const answered = request.options.find((option) => option.value === request.answer)?.label;
  return (
    <section
      className={`decision-request ${open ? 'is-open' : ''}`}
      aria-label={open ? 'Question waiting on a decision' : 'Question'}
    >
      <p className="decision-context">
        <CircleHelp className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{request.context}</span>
      </p>
      <p className="decision-question">{request.question}</p>
      <p className="decision-meta instrument">
        {request.requestedBy ? `${request.requestedBy} asked` : 'Asked'}
        {request.status === 'overtaken' ? ' · the card moved on, so this no longer applies' : ''}
        {request.status === 'answered' ? ` · answered: ${answered ?? request.answer ?? ''}` : ''}
      </p>
      {open && request.canAnswer ? (
        <div className="decision-answer">
          {request.options.length > 0 ? (
            <div className="decision-options">
              {request.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => onAnswer(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {request.decides ? null : (
            <form
              className="decision-free"
              onSubmit={(event) => {
                event.preventDefault();
                if (text.trim()) onAnswer(text.trim());
              }}
            >
              <input
                className="field min-w-0 flex-1"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  request.options.length > 0 ? 'Or answer in your own words' : 'Your answer'
                }
                aria-label="Your answer"
                maxLength={500}
              />
              <button type="submit" className="btn" disabled={busy || !text.trim()}>
                Send
              </button>
            </form>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function DecisionRequests({
  blipId,
  onChanged,
}: {
  blipId: string;
  onChanged?: (() => void) | undefined;
}) {
  const client = useQueryClient();
  const livePoll = useLivePoll();
  const { data } = useQuery({
    queryKey: queryKeys.decisions(blipId),
    queryFn: () => api.decisions.list(blipId),
    ...livePoll,
  });
  const answer = useMutation({
    mutationFn: (input: { id: string; answer: string }) =>
      api.decisions.answer(blipId, input.id, input.answer),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.decisions(blipId) }),
        client.invalidateQueries({ queryKey: queryKeys.notificationsRoot }),
        client.invalidateQueries({ queryKey: queryKeys.notificationCounts }),
      ]);
      // An answer may have moved the card.
      onChanged?.();
    },
    onError: (err) => {
      notify(err instanceof ApiError ? err.message : 'Could not send that answer', 'error');
      void client.invalidateQueries({ queryKey: queryKeys.decisions(blipId) });
    },
  });
  const requests = data?.requests ?? [];
  if (requests.length === 0) return null;
  return (
    <div className="decision-requests">
      {requests.map((request) => (
        <Request
          key={request.id}
          request={request}
          busy={answer.isPending}
          onAnswer={(text) => answer.mutate({ id: request.id, answer: text })}
        />
      ))}
    </div>
  );
}
