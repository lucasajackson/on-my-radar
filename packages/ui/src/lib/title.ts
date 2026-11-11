import { useEffect } from 'react';

const APP = 'On My Radar';

/**
 * The tab's name for this screen: "Reading list · On My Radar".
 *
 * Every route had the same title, so five tabs of the app — or a history
 * dropdown — were five identical "On My Radar"s. Each route names itself here,
 * with what its heading says; `null` while that is still loading keeps the
 * bare app name rather than a stale one from the previous screen.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP}` : APP;
  }, [title]);
}
