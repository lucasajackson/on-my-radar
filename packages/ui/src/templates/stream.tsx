/**
 * The default view, and the one every template without a bespoke shape falls
 * back to: the reverse-chronological card list On My Radar has always had.
 */
import { BlipStream } from '../components/blips';
import { readingProps, type TemplateViewProps } from './index';

export function StreamView(props: TemplateViewProps) {
  const {
    radar,
    blips,
    readOnly,
    loading,
    loadingMore,
    hasMore,
    onLoadMore,
    onChanged,
    newestId,
    emptyTitle,
    emptyHint,
  } = props;
  return (
    <BlipStream
      grid
      blips={blips}
      {...readingProps(props)}
      readOnly={readOnly}
      loading={loading}
      loadingMore={loadingMore}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      onChanged={onChanged}
      newestId={newestId ?? null}
      template={radar}
      commentsEnabled={radar.commentsEnabled}
      reactionsEnabled={radar.reactionsEnabled}
      emptyTitle={emptyTitle}
      emptyHint={emptyHint}
    />
  );
}
