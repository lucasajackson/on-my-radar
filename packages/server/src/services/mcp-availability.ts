import type { McpAvailabilityDto } from '@onmyradar/contract';
import { env } from '../env.js';
import { type Actor } from '../http.js';
import { assertHumanDecision } from './access.js';

/** What Settings → Connections needs to render copy-paste MCP config. */
export function getMcpAvailability(actor: Actor): McpAvailabilityDto {
  assertHumanDecision(actor, 'Check connection access while signed in to On My Radar.');
  return {
    enabled: env().MCP_ENABLED,
    url: `${env().PUBLIC_URL}/mcp`,
    available: env().MCP_ENABLED,
  };
}
