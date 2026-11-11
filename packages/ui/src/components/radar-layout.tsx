/**
 * The frame every radar template is drawn in: the capture box, the filters and the notes above the
 * template's own view, at a width the template chose.
 *
 * The width is the template's to declare (`PANES` in `templates/index.tsx`); this component never
 * asks which template it is hosting. A template that lays itself out in columns asks for `contained`,
 * which makes the pane a container, so its columns answer to the room the pane actually has (the
 * sidebar already took its share) rather than to the viewport:
 *
 *   xl  >= 1500px   index | open item | side panel
 *   lg  1000-1499   index | open item
 *   below 1000      one column
 *
 * A template whose index *is* the filters (a stream, a reading list) asks for `rail`: the filters
 * and the notes become a left rail and the capture box and the view share the column beside it.
 * Below 1000 that is the order it always was: capture, filters, notes, view.
 *
 * `contained` is opt-in because size containment makes the pane the containing block of anything
 * `position: fixed` inside it, which a board's popups and the architecture map rely on not happening.
 */
import type { ReactNode } from 'react';
import { useRef } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';

export interface RadarLayoutProps {
  /** A Tailwind max-width class, from the template's declaration. */
  measure: string;
  contained?: boolean;
  /** The filters and notes are a rail beside the view, not a band above it. */
  rail?: boolean;
  composer?: ReactNode;
  filters?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}

export function RadarLayout({
  measure,
  contained = false,
  rail = false,
  composer,
  filters,
  note,
  children,
}: RadarLayoutProps) {
  return (
    <div className={contained ? 'radar-pane' : undefined}>
      <div className={`mx-auto flex flex-col gap-4 px-4 py-4 sm:px-6 ${measure}`}>
        {rail ? (
          <div className="radar-cols">
            {composer ? <div className="radar-composer">{composer}</div> : null}
            <aside className="radar-rail">
              {filters}
              {note}
            </aside>
            <div className="radar-main">{children}</div>
          </div>
        ) : (
          <>
            {composer}
            {filters}
            {note}
            {children}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The open item, as `?sel=<id>` in the address. Choosing pushes an entry, so the back gesture on a
 * phone returns from the thread to the index; `back` undoes that push, or clears `sel` where the
 * page was opened straight onto an item and there is nothing to go back to.
 */
export function useSelectedItem() {
  const router = useRouter();
  const raw: unknown = useRouterState({
    select: (state): unknown => (state.location.search as Record<string, unknown>)['sel'],
  });
  const pushed = useRef(false);
  const sel = typeof raw === 'string' && raw !== '' ? raw : null;
  const go = (id: string | null, replace: boolean) =>
    void router.navigate({
      to: '.',
      search: ((prev: Record<string, unknown>) => ({ ...prev, sel: id ?? undefined })) as never,
      replace,
    });
  return {
    sel,
    // `replace` steps between items (a reader's next story) without a history entry of its own.
    select: (id: string, replace = false) => {
      if (id === sel) return;
      if (!replace) pushed.current = true;
      go(id, replace);
    },
    back: () => {
      if (pushed.current) {
        pushed.current = false;
        router.history.back();
      } else go(null, true);
    },
  };
}
