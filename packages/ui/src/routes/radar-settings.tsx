import { RadarSubscriptions } from '../components/radar-subscriptions';
import { HelpdeskPortalPanel } from '../components/integrations';
import { Select } from '../components/select';
import { FeedSources } from '../components/feed-sources';
import { RadarEmailCapture } from '../components/email-capture';
import { QueryError } from '../components/query-error';
/**
 * Everything that configures one radar, on one surface.
 *
 * ## Why this is a page and not a dialog
 *
 * It was a 512px modal, and it was measured: 1,370px of content at rest in a
 * 768px viewport — 1.78 screens — and 1,930px with the pickers open, which is
 * 3.22 screens on a phone sheet. Nineteen controls, eleven of them selects. The
 * six-card template grid was ~620px of it, over half the dialog, for a decision
 * you make once at creation; Name and Tagline, the fields you actually come back
 * for, were 40px each above it.
 *
 * And the specific mechanism behind "it feels like a mess": at the bottom of
 * that dialog there were **three independent nested scroll regions stacked
 * vertically** — the modal body, the glyph panel (`max-height: 17rem`) and the
 * theme preset grid — all painting a scrollbar at once, so a wheel or a swipe
 * did something different depending on which 100px band the pointer was over.
 * Tabs on a page dissolve that: the page is the only scroller, and the pickers
 * are handed `bounded={false}` so they no longer cap and scroll themselves.
 *
 * ## Why the other two dialogs are here too
 *
 * The radar header carried three unlabelled 20px icons — webhooks, share,
 * settings — all `canManage`-only, all configuring the same radar, opening at
 * ~650px, ~495px and 512px with two header treatments and three footers. And
 * "Radar settings" did not contain the settings: somebody asking "who can see
 * this?" opened the gear and found no answer. One entry point, four sections,
 * and the answer is where people look for it.
 *
 * ## Two halves, and only one of them has a Save
 *
 * *Identity & behaviour* and *Appearance* are form state — you change several
 * things and commit them together, so they share one action bar. *People &
 * links* and *Webhooks* take effect the moment you act, so a Save there would be
 * a button that does nothing. Rather than pretend otherwise, the bar is absent
 * on those two.
 *
 * `topicId` still goes through `api.radars.setTopic` separately from
 * `api.radars.update`, and only when it changed. Moving a radar between topics
 * can change who reaches it, so it goes through the one endpoint that knows the
 * rules for that rather than riding along in a patch that also changed the
 * colour. The separation is *more* honest on a page than it was in a dialog, not
 * less.
 */
import { useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Trash2 } from 'lucide-react';
import {
  ARCHIVE_WINDOW_CHOICES,
  acceptsCustomLanes,
  DEFAULT_ARCHIVE_AFTER_DAYS,
  DROP_BOX_TEMPLATE_IDS,
  RADAR_TEMPLATES,
  RADAR_TEMPLATE_IDS,
  THEME_AXES,
  archiveWindowLabel,
  archivesFor,
  hasGrouping,
  isClientFacingTemplate,
  isThemeable,
  statusesFor,
  templateFor,
  type RadarDto,
  type RadarTheme,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { accentStyle } from '../lib/theme';
import { queryKeys } from '../lib/session';
import { AppearancePicker } from '../components/appearance';
import { ThemePicker } from '../components/theme-picker';
import { SharePanel, Toggle, TopicPicker, WebhooksPanel } from '../components/radar-dialogs';
import {
  ConfirmDialog,
  Empty,
  RadarGlyph,
  Section,
  Spinner,
  notify,
} from '../components/primitives';

/**
 * The four sections, in the order they are worn: what the radar is, what it
 * looks like, who reaches it, what feeds it.
 */
import { RADAR_SETTINGS_SECTIONS, type RadarSettingsSection } from '../lib/radar-settings';
import { entry } from '../lib/registry';
import { LaneEditor } from '../components/lane-editor';
import { RadarAttachments } from '../components/radar-attachments';
import { useDocumentTitle } from '../lib/title';

const SECTION_LABELS: Record<RadarSettingsSection, string> = {
  identity: 'Identity & behaviour',
  appearance: 'Appearance',
  people: 'People & links',
  sources: 'Sources',
  webhooks: 'Webhooks',
  portal: 'Client portal',
};

/** Short forms for the tab strip on a phone, where the full names do not fit. */
const SECTION_SHORT: Record<RadarSettingsSection, string> = {
  identity: 'Identity',
  appearance: 'Look',
  people: 'People',
  sources: 'Sources',
  webhooks: 'Webhooks',
  portal: 'Portal',
};

export function RadarSettingsRoute() {
  const { radarId } = useParams({ from: '/_app/radar/$radarId/settings' });
  // In the URL, so a section is linkable and the back gesture returns to the one
  // you came from — the whole argument for this being a route.
  const { section } = useSearch({ from: '/_app/radar/$radarId/settings' });
  const client = useQueryClient();
  const navigate = useNavigate();

  const radarQuery = useQuery({
    queryKey: queryKeys.radar(radarId),
    queryFn: () => api.radars.get(radarId),
  });
  useDocumentTitle(radarQuery.data ? `Settings · ${radarQuery.data.radar.name}` : null);

  if (radarQuery.isLoading) return <Spinner label="Opening settings" />;

  if (radarQuery.error && !radarQuery.data)
    return (
      <QueryError
        error={radarQuery.error}
        resource="Radar settings"
        retry={() => radarQuery.refetch()}
      />
    );

  const radar = radarQuery.data?.radar;
  if (!radar) {
    return (
      <Empty
        title="That radar is not here"
        hint="It may have been deleted, or the link you followed is no longer shared with you."
      />
    );
  }

  if (!radar.access.canManage) {
    return (
      <Empty
        title="You cannot change this radar"
        hint="It is shared with you, which lets you read it and — depending on your role — capture into it. Changing how it works belongs to whoever owns it."
        action={
          <Link to="/radar/$radarId" params={{ radarId }} className="btn">
            <ArrowLeft className="h-4 w-4" />
            Back to the radar
          </Link>
        }
      />
    );
  }

  const isSmart = radar.kind === 'smart';
  // Smart radars hold no blips. The drop box supports outbound events but
  // still refuses inbound URLs (DESIGN.md §6.2).
  const canWebhook = !isSmart;
  // A client portal reaches a Helpdesk only (HELPDESK §3.2), so the tab is
  // there exactly where connecting one is possible.
  const sections = RADAR_SETTINGS_SECTIONS.filter((key) =>
    key === 'webhooks'
      ? canWebhook
      : key === 'sources'
        ? !isSmart
        : key === 'portal'
          ? !isSmart && isClientFacingTemplate(radar.template)
          : true,
  );
  const active: RadarSettingsSection = sections.includes(section as RadarSettingsSection)
    ? (section as RadarSettingsSection)
    : 'identity';

  const refetch = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.radar(radarId) }),
      client.invalidateQueries({ queryKey: queryKeys.radars }),
    ]);
  };

  return (
    <div
      className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 py-5 sm:px-6"
      style={accentStyle(radar.accent)}
    >
      <header className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-[color:var(--accent-from)]">
          <RadarGlyph glyph={radar.glyph} className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[21px] font-semibold tracking-tight">{radar.name}</h1>
          <p className="instrument mt-1 truncate">
            settings · {templateFor(radar.template).label.toLowerCase()}
            {radar.visibility === 'public' ? ' · public' : ''}
          </p>
        </div>
        {/* Desktop only: on a phone the shell's back control is always there
            now (history, or up to the radar on a direct load), and two back
            buttons one above the other asked which one was the real one. */}
        <Link
          to="/radar/$radarId"
          params={{ radarId }}
          className="btn hidden shrink-0 lg:inline-flex"
          aria-label="Back to the radar"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back</span>
        </Link>
      </header>

      {/*
        Tabs at every width, not just on a phone.

        Four sections down one page would put Webhooks two screens below the
        fold, which is the shape this page exists to stop being. It also keeps
        the page as the only scroll region, which is the actual fix for the
        three-nested-scrollers problem.
      */}
      <nav className="scroll-area section-tabs" aria-label="Settings sections">
        {sections.map((key) => (
          <Link
            key={key}
            to="/radar/$radarId/settings"
            params={{ radarId }}
            search={{ section: key }}
            replace
            className={`section-tab ${active === key ? 'is-active' : ''}`}
            aria-current={active === key ? 'page' : undefined}
            // At 390 the strip scrolls, and the sixth tab (Client portal) sat
            // past its edge while active: a page open on a tab you cannot see.
            ref={
              active === key
                ? (node: HTMLAnchorElement | null) =>
                    // jsdom has no scrollIntoView; a browser always does.
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                    node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
                : undefined
            }
          >
            <span className="hidden sm:inline">{SECTION_LABELS[key]}</span>
            <span className="sm:hidden">{SECTION_SHORT[key]}</span>
          </Link>
        ))}
      </nav>

      <div hidden={active !== 'identity' && active !== 'appearance'}>
        <RadarForm
          key={radar.id}
          radar={radar}
          section={active === 'appearance' ? 'appearance' : 'identity'}
          onSaved={() => void refetch()}
          onDeleted={() => {
            void client.invalidateQueries({ queryKey: queryKeys.radars });
            void navigate({ to: '/' });
          }}
        />
      </div>
      {active === 'sources' ? (
        <div className="flex flex-col gap-6">
          <FeedSources radarId={radar.id} />
          <RadarEmailCapture radarId={radar.id} isDropBox={radar.isDropBox} />
        </div>
      ) : active === 'people' ? (
        <SharePanel radar={radar} onChanged={() => void refetch()} />
      ) : active === 'portal' ? (
        <HelpdeskPortalPanel radar={radar} />
      ) : active === 'webhooks' ? (
        <div className="flex flex-col gap-8">
          {!radar.isDropBox && <WebhooksPanel radar={radar} />}
          <RadarSubscriptions key={radar.id} radarId={radar.id} />
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------- identity & appearance ------------------------ */

/**
 * The two form sections and the one action bar they share.
 *
 * Both live in one component, holding one draft, because they are one save.
 * Splitting the state per tab would mean changing the accent, switching to
 * Identity, saving, and silently losing the accent — which is the failure mode
 * of every tabbed form that saves per tab.
 */
function RadarForm({
  radar,
  section,
  onSaved,
  onDeleted,
}: {
  radar: RadarDto;
  section: 'identity' | 'appearance';
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(radar.name);
  const [tagline, setTagline] = useState(radar.tagline ?? '');
  const [topicId, setTopicId] = useState<string | null>(radar.topicId);
  const [accent, setAccent] = useState(radar.accent);
  const [glyph, setGlyph] = useState(radar.glyph);
  const [template, setTemplate] = useState(radar.template);
  const [changingTemplate, setChangingTemplate] = useState(false);
  const [editingLanes, setEditingLanes] = useState(false);
  const [grouping, setGrouping] = useState(radar.templateConfig.grouping ?? 'none');
  const [collapseDone, setCollapseDone] = useState(radar.templateConfig.collapseDone ?? false);
  /*
    `null` is a real value here and the draft keeps it.

    NULL means "no opinion — take the default"; 0 means never; a number is a
    decision. Seeding the draft with `?? DEFAULT` (which this did at first) looks
    harmless because the select has to render *some* option, but it collapses the
    first two: saving any unrelated field on a radar that had never expressed an
    opinion would write 30, and the day the default moves that radar is pinned to
    the old number by an edit nobody made. The select resolves the null for
    display only; the patch below sends the field solely when it changed.
  */
  const [archiveAfterDays, setArchiveAfterDays] = useState<number | null>(radar.archiveAfterDays);
  const [comments, setComments] = useState(radar.commentsEnabled);
  const [reactions, setReactions] = useState(radar.reactionsEnabled);
  const [theme, setTheme] = useState<RadarTheme>(radar.theme);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The confirmation stays open while the delete runs; without this its button
  // could be pressed again and send a second request for a radar already gone.
  const [deleting, setDeleting] = useState(false);
  const isSmart = radar.kind === 'smart';

  /*
    Identity and Appearance share a draft, keyed only by radar. Switching tabs
    preserves unsaved edits; switching radars starts a fresh draft. The
    action bar disables itself when nothing has changed: an enabled Save that
    would write back exactly what is already there teaches people to press it
    out of superstition.

    The theme is compared axis by axis off the registry rather than by
    `JSON.stringify`, which would have made key order part of the comparison —
    a theme built by `themeFor` and one deserialised from the API are the same
    theme, and a spurious "unsaved changes" on arrival is the kind of small lie
    that teaches people to ignore the line.
  */
  const dirty =
    name !== radar.name ||
    tagline !== (radar.tagline ?? '') ||
    topicId !== radar.topicId ||
    accent !== radar.accent ||
    glyph !== radar.glyph ||
    template !== radar.template ||
    grouping !== (radar.templateConfig.grouping ?? 'none') ||
    collapseDone !== (radar.templateConfig.collapseDone ?? false) ||
    archiveAfterDays !== radar.archiveAfterDays ||
    comments !== radar.commentsEnabled ||
    reactions !== radar.reactionsEnabled ||
    THEME_AXES.some((axis) => theme[axis.key] !== radar.theme[axis.key]);

  /*
    Leaving with unsaved work should cost a keystroke, not a shrug. Only armed
    while there is something to lose, so it never fires on a clean visit.

    It used to cover only `beforeunload` — closing the tab — which is the rare
    way out. "Back to the radar", the sidebar and the tab bar are in-app
    navigation and discarded the draft without a word. The router's blocker
    covers both. A section change is the same path with a new `?section=` and
    keeps the draft by design, so only a change of path asks; deleting the
    radar is a deliberate way out and never does.
  */
  const leaving = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      dirty && !leaving.current && next.pathname !== current.pathname,
    enableBeforeUnload: () => dirty && !leaving.current,
    withResolver: true,
  });

  const save = async () => {
    setSaving(true);
    try {
      await api.radars.update(radar.id, {
        name: name.trim(),
        tagline,
        accent,
        glyph,
        template,
        templateConfig: { grouping, collapseDone },
        // Only when they actually chose one. See the draft state above.
        ...(archiveAfterDays !== radar.archiveAfterDays ? { archiveAfterDays } : {}),
        theme,
        commentsEnabled: comments,
        reactionsEnabled: reactions,
        // The service validates topic access and commits the whole save together.
        ...(topicId !== radar.topicId ? { topicId } : {}),
      });
      notify('Radar updated');
      onSaved();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the radar', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.radars.remove(radar.id);
      notify('Radar deleted');
      leaving.current = true;
      onDeleted();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not delete the radar', 'error');
      setDeleting(false);
    }
  };

  const offered = radar.isDropBox ? DROP_BOX_TEMPLATE_IDS : RADAR_TEMPLATE_IDS;
  const current = entry(RADAR_TEMPLATES, template);
  /*
    The lanes this radar actually draws: its own vocabulary where it has been
    given one, its template's otherwise.

    Editable in its own dialog (`LaneEditor`). This page used to show them only,
    on the argument that a form would restate the lane rules — but the rules are
    the contract's `validateLanes`, which the dialog runs as-is, and the one
    rule that needs the database (no stranded blips) is refused by the server
    and shown beside the lanes. Nothing is restated. Only the saved template can
    be edited: lanes are validated against the template they will live on.
  */
  const lanes = statusesFor(template, radar.templateConfig);
  const hasCustomLanes =
    Boolean(radar.templateConfig.lanes?.length) && statusesFor(template).length > 0;
  const canEditLanes =
    !isSmart && template === radar.template && acceptsCustomLanes(radar.template);

  const restoreTemplateLanes = async () => {
    try {
      await api.radars.update(radar.id, { templateConfig: { lanes: null } });
      notify('Lanes restored');
      onSaved();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not restore the lanes', 'error');
    }
  };

  return (
    <>
      {section === 'identity' ? (
        <div className="flex flex-col gap-5">
          <Section title="Identity">
            <label className="flex flex-col gap-1.5">
              <span className="instrument">Name</span>
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="instrument">Tagline</span>
              <input
                className="field"
                value={tagline}
                placeholder="What is this radar for?"
                onChange={(e) => setTagline(e.target.value)}
              />
            </label>

            <TopicPicker radar={radar} topicId={topicId} onChange={setTopicId} />
          </Section>

          <Section title="Template">
            {/*
              A summary row, not a standing six-card grid.

              The grid was ~620px — over half the dialog at rest — for a choice
              you make once. Switching template is a decision, so it is behind a
              deliberate action; what stays on screen is the answer to "what
              shape is this radar", which is what you came to find out.
            */}
            {changingTemplate ? (
              <>
                <div className="template-grid">
                  {offered.map((key) => {
                    const def = RADAR_TEMPLATES[key];
                    const active = template === key;
                    return (
                      <button
                        key={key}
                        aria-pressed={active}
                        onClick={() => setTemplate(key)}
                        className={`template-card ${active ? 'is-active' : ''}`}
                      >
                        <span className="template-card-name">{def.label}</span>
                        <span className="template-card-blurb">{def.blurb}</span>
                        {def.statuses.length > 0 ? (
                          <span className="instrument template-card-lanes">
                            {def.statuses.map((lane) => lane.label).join(' · ')}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                <button
                  className="btn btn-ghost self-start"
                  onClick={() => {
                    setTemplate(radar.template);
                    setChangingTemplate(false);
                  }}
                >
                  Keep {entry(RADAR_TEMPLATES, radar.template)?.label}
                </button>
              </>
            ) : (
              <div className="template-summary">
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium">{current?.label ?? template}</div>
                  <div className="note mt-0.5">{current?.blurb}</div>
                  {lanes.length > 0 ? (
                    <div className="instrument template-card-lanes mt-1">
                      {lanes.map((lane) => lane.label).join(' · ')}
                    </div>
                  ) : null}
                  {hasCustomLanes ? (
                    <p className="note mt-1">
                      This radar has lanes of its own rather than the template's.
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  <button className="btn" onClick={() => setChangingTemplate(true)}>
                    Change template
                  </button>
                  {canEditLanes ? (
                    <button className="btn" onClick={() => setEditingLanes(true)}>
                      Edit lanes
                    </button>
                  ) : null}
                  {hasCustomLanes ? (
                    <button className="btn btn-ghost" onClick={() => void restoreTemplateLanes()}>
                      Use {current?.label}'s lanes
                    </button>
                  ) : null}
                </div>
              </div>
            )}

            {radar.isDropBox ? (
              // Said out loud, because a shorter list than the one on every
              // other radar reads as a bug otherwise. It is the reason, not an
              // apology.
              <p className="note">
                Your drop box holds things you have not decided anything about yet, so it can only
                be a shape that takes anything. The other templates each decide what their blips
                are.
              </p>
            ) : null}
            {lanes.length > 0 && statusesFor(radar.template, radar.templateConfig).length === 0 ? (
              <p className="note">
                Existing blips have no lane yet, so they will all start in {lanes[0]?.label}.
              </p>
            ) : null}
          </Section>

          {/* Asked of the registry, not of the id. `template === 'microblog'`
              is exactly the special-casing bb602ab removed everywhere else. */}
          {hasGrouping(template) ||
          archivesFor(template) ||
          entry(RADAR_TEMPLATES, template)?.layout === 'board' ? (
            <Section title="Behaviour">
              {hasGrouping(template) ? (
                <label className="flex flex-col gap-1.5">
                  <span className="instrument">Grouping</span>
                  <Select
                    className="field"
                    value={grouping}
                    onValueChange={(value) => setGrouping(value as 'none' | 'day')}
                    options={[
                      { value: 'none', label: 'Continuous — one long timeline' },
                      { value: 'day', label: 'By day — a diary, with a rule between days' },
                    ]}
                  />
                </label>
              ) : null}
              {entry(RADAR_TEMPLATES, template)?.layout === 'board' ? (
                <Toggle
                  label="Start with finished lanes furled"
                  hint="Done and Abandoned open as a narrow rail, giving the working lanes the width. They stay drop targets, and one click unfurls them."
                  checked={collapseDone}
                  onChange={setCollapseDone}
                />
              ) : null}
              {/* Asked of the registry, like everything else in this section. A
                  decision log never renders this at all — its rejected and
                  superseded entries are the artifact, so there is nothing here
                  it would be right to hide. */}
              {archivesFor(template) ? (
                <label className="flex flex-col gap-1.5">
                  <span className="instrument">Archive finished blips</span>
                  <Select
                    className="field"
                    value={String(archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS)}
                    onValueChange={(value) => setArchiveAfterDays(Number(value))}
                    options={ARCHIVE_WINDOW_CHOICES.map((days) => ({
                      value: String(days),
                      label: `${archiveWindowLabel(days)}${days === DEFAULT_ARCHIVE_AFTER_DAYS ? ' — the default' : ''}`,
                    }))}
                  />
                  <span className="note">
                    Blips you have finished or dropped stop being loaded once nothing has happened
                    to them for this long. Nothing is deleted: the lane header says how many went
                    and links to them, commenting or editing one brings it back, and widening this
                    returns every one of them.
                  </span>
                </label>
              ) : null}
            </Section>
          ) : null}

          <Section title="Conversation">
            <Toggle
              label="Comments"
              hint="Anyone this radar is shared with can comment on its blips — including on blips they cannot edit. Turning this off hides the composer; comments already written stay readable."
              checked={comments}
              onChange={setComments}
            />
            <Toggle
              label="Reactions"
              hint="A small set of marks people can put on a blip. Public readers can see the counts but never add one."
              checked={reactions}
              onChange={setReactions}
            />
          </Section>

          {radar.isDropBox ? (
            <p className="note">
              Your Drop box is your permanent inbox. Move or delete individual blips to clear it.
            </p>
          ) : (
            <div className="danger-row">
              <span className="note">
                {isSmart
                  ? 'Deleting this saved search leaves every blip it gathers exactly where it is.'
                  : 'Deleting this radar removes every blip in it. It cannot be undone.'}
              </span>
              <button className="btn btn-danger-quiet" onClick={() => setConfirming(true)}>
                <Trash2 className="h-4 w-4" />
                Delete radar
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <Section title="Mark">
            {/* `bounded={false}`: on a page there is no dialog Save for a long
                panel to push off the bottom, so the panel does not need to cap
                itself and paint a second scrollbar inside the first. */}
            <AppearancePicker
              accent={accent}
              glyph={glyph}
              onAccent={setAccent}
              onGlyph={setGlyph}
              label={null}
              bounded={false}
            />
          </Section>

          {/* Registry-gated, not id-gated. A template whose own chrome is
              load-bearing declares `themeable: false` and the control is simply
              not here — see `isThemeable` and the kanban board's declaration. */}
          {isThemeable(template) ? (
            <Section title="Style">
              <ThemePicker
                theme={theme}
                accent={accent}
                radarName={name}
                onChange={setTheme}
                label={null}
                bounded={false}
              />
            </Section>
          ) : (
            <p className="note">
              {current?.label} draws its own chrome — its lanes, its rails, its cards — so a paper
              and an ink would fight it rather than dress it. Switch to a reading template to style
              this radar.
            </p>
          )}
        </div>
      )}

      {/*
        The action bar.

        Sticky to the bottom of the viewport rather than parked at the end of the
        content, because the audit's other finding about this surface was that
        "Save changes" sat below 3.2 phone screens of scroll and nothing asserted
        you could get to it. Now it cannot leave.
      */}
      <div className="settings-actions">
        <span className="note min-w-0 flex-1">
          {dirty ? 'Unsaved changes.' : 'Everything here is saved.'}
        </span>
        <button
          className="btn btn-accent"
          data-role="settings-save"
          disabled={saving || !dirty || name.trim().length === 0}
          onClick={() => void save()}
        >
          <Check className="h-4 w-4" />
          Save changes
        </button>
      </div>

      {confirming && !radar.isDropBox ? (
        <ConfirmDialog
          title="Delete this radar?"
          phrase={radar.name}
          confirmLabel="Delete radar"
          danger
          body={
            /*
              A smart radar owns no blips — it is a saved search over other
              radars — so "this removes 0 blips" is both true and useless, and
              the sentence somebody actually needs is that the blips it was
              gathering are untouched.
            */
            radar.kind === 'smart' ? (
              <>
                This deletes the saved search.{' '}
                <strong className="text-[color:var(--paper)]">
                  Nothing it was gathering is deleted
                </strong>{' '}
                — every blip stays on the radar it was captured into.
              </>
            ) : (
              <>
                This removes{' '}
                <strong className="text-[color:var(--paper)]">
                  {radar.blipCount} {radar.blipCount === 1 ? 'blip' : 'blips'}
                </strong>{' '}
                and everything attached to them. It cannot be undone.
                <RadarAttachments radar={radar} />
              </>
            )
          }
          busy={deleting}
          onClose={() => setConfirming(false)}
          onConfirm={() => void remove()}
        />
      ) : null}

      {editingLanes ? (
        <LaneEditor radar={radar} onClose={() => setEditingLanes(false)} onSaved={onSaved} />
      ) : null}

      {blocker.status === 'blocked' ? (
        <ConfirmDialog
          title="Leave without saving?"
          confirmLabel="Discard changes"
          danger
          body="The changes on this page have not been saved. Leaving now throws them away."
          onClose={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      ) : null}
    </>
  );
}
