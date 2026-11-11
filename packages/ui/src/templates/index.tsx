/**
 * Template views.
 *
 * The registry in `@onmyradar/contract` says what a template *is*; this says how
 * one is drawn. The mapping is by `layout`, not by template id, which is what
 * keeps the abstraction worth having: a template that needs no bespoke view
 * declares `layout: 'stream'` and gets the ordinary card list, and everything
 * that makes it *itself* — its order, its lane rail, the facets its cards lead
 * with, what its composer infers — is read off the registry by the shared
 * components rather than branched on here.
 *
 * The reading list is exactly that, and it is a real template rather than a
 * relabelled stream because those declarations change how it behaves. What it
 * is not is proof that a template should *never* cost view code: the decision
 * log needed a shape a list cannot draw, and pretending otherwise is how it
 * ended up indistinguishable from the stream.
 *
 * Adding a template with a genuinely new shape means adding one `layout` value
 * and one component below. Nothing else in the SPA needs to know it exists.
 */
import type { BlipDto, RadarDto, RadarLayout } from '@onmyradar/contract';
import { ArchitectureView } from './architecture';
import { BoardView } from './board';
import { DiscussionView } from './discussion';
import { LogView } from './log';
import { TimelineView } from './timeline';
import { ReaderView } from './reader';
import { StreamView } from './stream';

/**
 * How the blips are being *read*, as opposed to what the template does with them.
 *
 * These two settle the same question — is this page being read by a stranger —
 * and they exist on the shared props rather than on one view because a public
 * radar can be on any template. Before this the public page rendered `BlipStream`
 * unconditionally and a published microblog came out as a stream with kind
 * badges on it: the server was already sorting the blips in the template's own
 * order, and the SPA was throwing the template away on arrival.
 */
export interface ReadingContext {
  /** False on a public page: the tag screens are behind sign-in. */
  linkTags?: boolean;
  /** Set on a public page. Routes the thread fetch through the public identity. */
  publicSlug?: string;
}

export interface TemplateViewProps extends ReadingContext {
  radar: RadarDto;
  blips: BlipDto[];
  readOnly: boolean;
  loading: boolean;
  /**
   * A next page is being fetched. Distinct from `loading` (any fetch at all):
   * the "More" spinner keyed off `loading` flashed at the foot of the list after
   * every capture, edit and focus refetch, none of which load more.
   */
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onChanged: () => void;
  newestId?: string | null;
  emptyTitle: string;
  emptyHint: string;
  /**
   * How many blips have aged out of each lane, keyed by lane id.
   *
   * Passed down rather than fetched here because the counts arrive on the
   * radar's `/facets` call along with the tag and state chips, and a second
   * request for a number that is already on the wire is a second thing that can
   * disagree with the first. Absent on the public page, which has no facets
   * endpoint and no archive control.
   */
  archivedCounts?: Record<string, number>;
}

/**
 * The reading context as props a `BlipCard` or a `BlipStream` can be spread
 * with. One helper so five views cannot end up disagreeing about what "not
 * given" meant — the same argument as `conversationFor` in the contract.
 */
export function readingProps({ linkTags, publicSlug }: ReadingContext) {
  return {
    linkTags: linkTags ?? true,
    ...(publicSlug ? { publicSlug } : {}),
  };
}

const VIEWS: Record<RadarLayout, (props: TemplateViewProps) => React.ReactElement> = {
  stream: StreamView,
  board: BoardView,
  timeline: TimelineView,
  log: LogView,
  discussion: DiscussionView,
  architecture: ArchitectureView,
  reader: ReaderView,
};

/**
 * How wide the radar pane is for each layout, declared here beside the view it belongs to so no
 * shared code ever has to ask which template it is hosting. (A layout is what a template names in
 * the registry, so a reading list and a stream, or a helpdesk and a kanban, share a pane.)
 *
 * Every layout takes up to `--radar-max`; width goes into structure, not into the line, and prose
 * keeps its own measure inside a column. A layout that is columns rather than a column
 * (`contained`) answers to the pane's own width; see `RadarLayout`. A layout whose filters are its
 * index asks for the `rail`. A board and the architecture map are not `contained`: size
 * containment makes the pane the containing block of anything `position: fixed` inside it, which a
 * board's popups and the map rely on not happening.
 */
interface Pane {
  measure: string;
  contained?: boolean;
  rail?: boolean;
}
const WIDE = 'max-w-[var(--radar-max)]';
const PANES: Record<RadarLayout, Pane> = {
  stream: { measure: WIDE, contained: true, rail: true },
  timeline: { measure: WIDE, contained: true },
  log: { measure: WIDE, contained: true },
  board: { measure: WIDE },
  architecture: { measure: WIDE },
  discussion: { measure: WIDE, contained: true },
  reader: { measure: WIDE, contained: true, rail: true },
};

/** The pane for a layout; one this build does not know (a newer server) gets the stream's. */
export function paneFor(layout: string): Required<Pane> {
  const pane = (PANES as Partial<Record<string, Pane>>)[layout] ?? PANES.stream;
  return { contained: false, rail: false, ...pane };
}

export function TemplateView(props: TemplateViewProps & { layout: RadarLayout }) {
  const { layout: asked, ...rest } = props;
  // The charter is read through the signed-in API; a public page is drawn as the stream.
  const layout = asked === 'architecture' && rest.publicSlug ? 'stream' : asked;
  // A layout this build does not know (a newer server) is drawn as the stream.
  const View =
    (VIEWS as Partial<Record<string, (typeof VIEWS)[RadarLayout]>>)[layout] ?? StreamView;
  // One radar's view never carries over to another's: an editing session saves to the radar it began in.
  return <View key={rest.radar.id} {...rest} />;
}
