/**
 * The agent a page is about, for the tabs under `/repo/$agentId`.
 *
 * The shell loads it once and every tab reads it from here, so switching tabs
 * never refetches the header and a tab can never render a different agent
 * from the one the header names.
 */
import { createContext, useContext } from 'react';
import type { Harness, RepoAgentDto } from '@onmyradar/contract';

export interface AgentPage {
  agent: RepoAgentDto;
  /** Open the Use-in dialog on a tool. */
  useIn: (harness: Harness) => void;
  /** People with prompt edit, not waiting to accept. */
  canEditPrompt: boolean;
}

export const AgentPageContext = createContext<AgentPage | null>(null);

export function useAgentPage(): AgentPage {
  const page = useContext(AgentPageContext);
  if (!page) throw new Error('useAgentPage outside /repo/$agentId');
  return page;
}
