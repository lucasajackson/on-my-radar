import { createContext, useContext } from 'react';

/**
 * The radar page's hold on the address bar while a card is open. Absent outside
 * an app radar (public radars, search, dashboards), where a card's modal stays
 * the local thing it always was.
 */
export interface BlipRoute {
  /** The card the address names, if any. */
  openId: string | null;
  /** Push the card's address. False when the address already names it; the caller then draws nothing new. */
  open: (id: string) => boolean;
  /** Back to the radar address: the history entry `open` pushed, or a replace for a cold load. */
  close: () => void;
}

export const BlipRouteContext = createContext<BlipRoute | null>(null);
export const useBlipRoute = () => useContext(BlipRouteContext);
