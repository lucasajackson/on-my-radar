/**
 * What lost its words. Removing or rewording charter text is never refused; an ADR amendment or a
 * link whose words are gone is orphaned instead, and waits here with the last text it was attached
 * to. Each can be pointed at new words (re-anchor), let go (an ADR becomes free-standing, a link is
 * removed), or looked at in the last version that still had it (the history view's).
 */
import type { ArchitectureDto, CharterOrphanDto } from '@onmyradar/contract';
import { SeeInVersion } from './architecture-history';
import { useLinkActions } from './architecture-links';

const CAUSES: Record<CharterOrphanDto['cause'], string> = {
  text_changed: 'Its words were changed or removed.',
  ambiguous: 'Its words now appear twice, so it cannot tell which one it meant.',
  diff_not_exact: 'The edit was too large to tell where its words went.',
};

/** Why Accept is off on an orphaned ADR, for a tooltip and for the card. */
export const ORPHAN_ACCEPT =
  'Accept is off while this ADR has lost its text. Re-anchor it to the passage that now says this, or make it free-standing.';

export function OrphanTray({ data }: { data: ArchitectureDto }) {
  const actions = useLinkActions();
  const orphans = data.orphans ?? [];
  if (orphans.length === 0) return null;
  const elementKind = (id: string) =>
    data.boundaries.some((b) => b.id === id) ? 'boundary' : 'contract';
  return (
    <section className="arch-section charter-orphans" aria-label="Orphaned">
      <h2 className="instrument">Orphaned · {orphans.length}</h2>
      {orphans.map((orphan) => {
        const isLink = orphan.kind === 'link';
        const adr = isLink ? undefined : data.adrs.find((a) => a.id === orphan.subject.id);
        const target = {
          anchorId: orphan.anchorId,
          kind: orphan.kind,
          label: orphan.subject.label,
        } as const;
        const active = actions?.reanchoring === orphan.anchorId;
        return (
          <div
            key={orphan.anchorId}
            className={`charter-orphan${active ? ' is-reanchoring' : ''}`}
            aria-current={active ? 'true' : undefined}
          >
            <div className="charter-orphan-head">
              <span className="chip-status is-orphan">Orphaned</span>
              {isLink ? (
                <>
                  <span className="instrument">Link</span>
                  <span className="charter-orphan-lane">
                    to {elementKind(orphan.subject.id)} {orphan.subject.label}
                  </span>
                </>
              ) : (
                <>
                  <span className="instrument">{orphan.subject.label}</span>
                  {orphan.subject.lane ? (
                    <span className="instrument charter-orphan-lane">{orphan.subject.lane}</span>
                  ) : null}
                </>
              )}
            </div>
            {adr ? <p className="charter-orphan-title">{adr.title}</p> : null}
            {orphan.quote ? (
              <blockquote className="charter-orphan-quote">{orphan.quote}</blockquote>
            ) : null}
            <p className="charter-orphan-cause">
              {CAUSES[orphan.cause]} It last had a place in v{orphan.resolvedVersion}.
            </p>
            {orphan.subject.lane === 'proposed' ? (
              <p className="charter-orphan-hint">{ORPHAN_ACCEPT}</p>
            ) : null}
            {active ? (
              <div className="charter-orphan-actions">
                <p className="charter-orphan-hint">Select the passage in the charter.</p>
                <button type="button" className="btn btn-ghost" onClick={actions.cancelReanchor}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="charter-orphan-actions">
                {actions?.canWrite ? (
                  <>
                    <button type="button" className="btn" onClick={() => actions.reanchor(target)}>
                      Re-anchor
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => actions.dismiss(target)}
                    >
                      {isLink ? 'Unlink' : 'Make free-standing'}
                    </button>
                  </>
                ) : null}
                {actions?.historyRadarId ? (
                  <SeeInVersion
                    radarId={actions.historyRadarId}
                    version={orphan.resolvedVersion}
                    anchorId={orphan.anchorId}
                  />
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
