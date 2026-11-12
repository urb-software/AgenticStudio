import { AgentList } from '@/modules/agents';

export function AgentBadge({ name }: { name: string }) {
  return <AgentList names={[name]} />;
}
