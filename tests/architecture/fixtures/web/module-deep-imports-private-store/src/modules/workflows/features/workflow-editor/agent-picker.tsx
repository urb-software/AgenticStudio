import { useAgentDraftStore } from '@/modules/agents/features/agent-editor/store';

export function AgentPicker() {
  const draft = useAgentDraftStore((state) => state.draft);
  return <span>{draft}</span>;
}
