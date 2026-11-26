import { vi } from 'vitest';
import type {
  ProblemDetails,
  SkillDetailOutput,
  SkillListOutput,
  SkillSummaryOutput,
} from '../../../platform/api';

export const SKILLS_COMMIT = '0123456789abcdef0123456789abcdef01234567';

export function skillList(overrides: Partial<SkillListOutput> = {}): SkillListOutput {
  return {
    commit: SKILLS_COMMIT,
    repository: { state: 'ready', note: null },
    truncated: false,
    skills: [],
    ...overrides,
  };
}

export function skillDetail(
  skill: SkillSummaryOutput,
  extras: { instructions?: string; files?: { path: string; size: number }[] } = {},
): SkillDetailOutput {
  return {
    commit: SKILLS_COMMIT,
    repository: { state: 'ready', note: null },
    ...skill,
    instructions: extras.instructions ?? '',
    files: extras.files ?? [],
    usedBy: [],
    usedByTruncated: false,
  };
}

function json(status: number, body: unknown): Response {
  const contentType = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

/** The skills API behind `fetch`: the list, and each detail by name (404 for any other). */
export function fakeSkillsApi(
  initial: SkillListOutput,
  details: Record<string, SkillDetailOutput> = {},
) {
  let list = initial;
  const calls: string[] = [];
  const listFailures: { status: number; body: unknown }[] = [];
  const fetch = vi.fn((request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    calls.push(pathname);
    if (pathname === '/api/skills') {
      const failure = listFailures.shift();
      return Promise.resolve(failure ? json(failure.status, failure.body) : json(200, list));
    }
    const match = /^\/api\/skills\/([^/]+)$/.exec(pathname);
    const found = match ? details[decodeURIComponent(match[1] ?? '')] : undefined;
    return Promise.resolve(
      found
        ? json(200, found)
        : json(404, {
            type: 'urn:agentic-studio:problem:skill-not-found',
            title: 'Skill not found',
            status: 404,
            detail: 'No skill has this name.',
            correlationId: 'c-1',
          } satisfies ProblemDetails),
    );
  });
  vi.stubGlobal('fetch', fetch);
  return {
    calls,
    /** What the next reads of the list and of the skills answer. */
    serve(next: SkillListOutput, nextDetails: Record<string, SkillDetailOutput> = details) {
      list = next;
      Object.assign(details, nextDetails);
    },
    failNextList(status: number, body: unknown) {
      listFailures.push({ status, body });
    },
    count: (path: string) => calls.filter((call) => call === path).length,
  };
}
