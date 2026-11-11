import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { templateFor } from '@onmyradar/contract';
import { Link } from '@tanstack/react-router';
import { ApiError, api } from '../lib/api';
import { invalidateBlipLists } from '../lib/session';
import { BlipCard, cardLabel } from './blips';
import { Modal, Spinner } from './primitives';
import { QueryError } from './query-error';
import { useLivePoll } from '../lib/polling';

/** Notification URLs identify content; current access and location come only from the API. */
export function LinkedBlip({
  id,
  originRadarId,
  onClose,
}: {
  id: string;
  originRadarId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const currentId = useRef(id);
  currentId.current = id;
  const livePoll = useLivePoll();
  const detail = useQuery({
    queryKey: ['blips', 'detail', id],
    queryFn: () => api.blips.get(id),
    ...livePoll,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: 1,
  });
  const blip = detail.data?.blip;
  /*
    The radar is read fresh — access and location come from the API, never from
    the URL — but not *after* the blip any more. It waited for the blip to say
    which radar it lives in, which is one full round trip in series on every
    deep link, when nine times in ten it lives exactly where the link said. So
    the link's radar is read alongside the blip; if the blip turns out to have
    moved, the key follows it and the right radar is read. Nothing renders until
    the radar read is the blip's own.
  */
  const radarId = blip?.radarId ?? originRadarId;
  const radar = useQuery({
    queryKey: ['radar', 'linked', radarId],
    queryFn: radarId ? () => api.radars.get(radarId) : skipToken,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: 1,
  });
  const radarIsBlips = Boolean(blip && radar.data?.radar.id === blip.radarId);
  const boardDetails = radarIsBlips && templateFor(radar.data?.radar.template).layout === 'board';
  // A failure reading the link's radar only counts once the blip says that is
  // where it lives: a blip moved out of a radar you lost is still yours to see.
  const error = detail.error ?? (blip ? radar.error : null);
  const unavailable = error instanceof ApiError && [403, 404].includes(error.status);
  const contentReady =
    !error && radarIsBlips && detail.isFetchedAfterMount && radar.isFetchedAfterMount;
  const refresh = (deletedId?: string) => {
    void (async () => {
      if (deletedId) {
        await client.cancelQueries({ queryKey: ['blips', 'detail', deletedId], exact: true });
      }
      await Promise.all([
        invalidateBlipLists(client, deletedId),
        client.invalidateQueries({ queryKey: ['radar'] }),
      ]);
    })();
  };
  return (
    <Modal
      title={contentReady && blip && boardDetails ? cardLabel(blip) : 'Blip'}
      description={
        !error && radar.isFetchedAfterMount
          ? (radar.data?.radar.name ?? 'Linked blip')
          : 'Opening the linked blip'
      }
      onClose={onClose}
      size={boardDetails ? 'kanban' : 'md'}
      fill={boardDetails}
    >
      {unavailable ? (
        <p role="status">
          This blip is no longer available. It may have been deleted, or your access may have
          changed.
        </p>
      ) : error ? (
        <QueryError
          error={error}
          resource="Linked blip"
          retry={async () => {
            await detail.refetch();
            if (blip) await radar.refetch();
          }}
        />
      ) : !blip ||
        !radar.data ||
        !radarIsBlips ||
        !detail.isFetchedAfterMount ||
        !radar.isFetchedAfterMount ? (
        <div role="status">
          <Spinner /> Loading blip…
        </div>
      ) : (
        <>
          {blip.radarId !== originRadarId ? (
            <p className="note mb-3">
              This blip is now in{' '}
              <Link to="/radar/$radarId" params={{ radarId: blip.radarId }} search={{}}>
                {radar.data.radar.name}
              </Link>
              .
            </p>
          ) : null}
          {blip.archivedAt ? <p className="note mb-3">Archived blip</p> : null}
          <BlipCard
            blip={blip}
            template={radar.data.radar}
            readOnly={!radar.data.radar.access.canWrite}
            onChanged={refresh}
            commentsEnabled={radar.data.radar.commentsEnabled}
            reactionsEnabled={radar.data.radar.reactionsEnabled}
            threadOpen={boardDetails && radar.data.radar.commentsEnabled}
            decisions
            keepConversationWhileEditing={boardDetails}
            {...(boardDetails
              ? {
                  onDeleted: (deletedId: string) => {
                    if (deletedId === currentId.current) onClose();
                  },
                }
              : {})}
          />
        </>
      )}
    </Modal>
  );
}
