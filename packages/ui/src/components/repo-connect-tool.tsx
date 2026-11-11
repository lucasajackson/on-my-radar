/** The list and an agent page enter the same tool-specific setup journey. */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { HARNESSES, resolveHarness, type Harness } from '@onmyradar/contract';
import { api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { Modal, Spinner } from './primitives';
import { QueryError } from './query-error';
import { Select } from './select';
import { toolOptions } from './repo-common';

export function ConnectToolDialog({ onClose }: { onClose: () => void }) {
  const [agentId, setAgentId] = useState('');
  const [chosenTool, setChosenTool] = useState<Harness | null>(null);
  const mine = useQuery({
    queryKey: [...queryKeys.repoAgents, 'mine'],
    queryFn: () => api.agentRepo.list({ view: 'mine' }),
  });
  const shared = useQuery({
    queryKey: [...queryKeys.repoAgents, 'shared'],
    queryFn: () => api.agentRepo.list({ view: 'shared' }),
  });
  const agents = [...(mine.data?.agents ?? []), ...(shared.data?.agents ?? [])].filter(
    (agent) => !agent.archived && !agent.awaitingAccept,
  );
  const agent = agents.find((item) => item.id === agentId);
  const harness = chosenTool ?? agent?.primaryHarness ?? 'claude-code';
  const tools = (Object.keys(HARNESSES) as Harness[]).sort(
    (a, b) => Number(b === agent?.primaryHarness) - Number(a === agent?.primaryHarness),
  );
  return (
    <Modal title="Connect a tool" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="note">Choose the agent you want to use and the tool that will run it.</p>
        {mine.isLoading || shared.isLoading ? <Spinner label="Reading your agents" /> : null}
        {mine.error || shared.error ? (
          <QueryError
            error={mine.error ?? shared.error}
            resource="Your agents"
            retry={() => {
              void mine.refetch();
              void shared.refetch();
            }}
          />
        ) : null}
        {!mine.isLoading &&
        !shared.isLoading &&
        !mine.error &&
        !shared.error &&
        agents.length === 0 ? (
          <p className="note">
            Create or import an agent first, then choose a tool here.{' '}
            <Link to="/repo/new" className="inline-flex min-h-11 items-center underline">
              New agent
            </Link>
          </p>
        ) : null}
        {agents.length > 0 ? (
          <>
            <Select
              aria-label="Agent to connect"
              className="min-h-11"
              value={agentId}
              placeholder="Choose an agent"
              options={agents.map((item) => ({
                value: item.id,
                label: item.name,
                description: item.ref,
              }))}
              onValueChange={(value) => {
                setAgentId(value);
                setChosenTool(null);
              }}
            />
            <Select
              aria-label="Tool to connect"
              className="min-h-11"
              value={harness}
              options={toolOptions(tools)}
              onValueChange={(value) => {
                const next = resolveHarness(value);
                if (next) setChosenTool(next);
              }}
            />
            {agent ? (
              <Link
                to="/repo/$agentId"
                params={{ agentId: agent.id }}
                search={{ use: harness }}
                className="btn btn-accent min-h-11 self-start"
              >
                Continue setup
              </Link>
            ) : (
              <button className="btn min-h-11 self-start" disabled>
                Continue setup
              </button>
            )}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
