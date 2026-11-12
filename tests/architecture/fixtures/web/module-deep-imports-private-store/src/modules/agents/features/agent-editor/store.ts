import { create } from 'zustand';

export const useAgentDraftStore = create<{ draft: string }>(() => ({ draft: '' }));
