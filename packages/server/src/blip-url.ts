import { env } from './env.js';

/**
 * The address of one card in the app: the stable link a person can paste in chat. `blip.url` is
 * the link a card *carries*, so this one travels beside the blip, never inside it.
 */
export function blipUrl(blip: { id: string; radarId: string }): string {
  return `${env().APP_URL}/radar/${blip.radarId}/blip/${blip.id}`;
}
