'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../../platform/api';

const SKILLS_KEY = ['agents', 'skills', 'list'] as const;
const SKILL_KEY = ['agents', 'skills', 'detail'] as const;

/** The skills as the API lists them; refetched on window focus, which the API answers from memory. */
export function useSkills() {
  return useQuery({ queryKey: SKILLS_KEY, queryFn: api.listSkills });
}

/**
 * One skill at `commit`, the commit of the list it was opened from. A commit never changes, so
 * the answer is kept and never refetched on focus: the API may read Git for a skill beyond the
 * listed ones, and a new commit is a new key.
 */
export function useSkill(name: string, commit: string | null) {
  return useQuery({
    queryKey: [...SKILL_KEY, commit, name] as const,
    queryFn: () => api.getSkill(name),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
