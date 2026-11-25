import { vi } from 'vitest';
import type { ProblemDetails, ProjectOutput, RepositoryOutput } from '../../../platform/api';

export const DEFINITIONS_PROJECT: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000d1',
  name: 'Agent definitions',
  mergeMethod: 'squash',
  kind: 'definitions',
  defaultAgent: null,
  createdAt: '2026-11-12T09:00:00.000Z',
};

export function problem(status: number, title: string, extras: Partial<ProblemDetails> = {}) {
  return {
    type: 'about:blank',
    title,
    status,
    detail: `${title} (test)`,
    correlationId: '00000000-0000-4000-8000-000000000000',
    ...extras,
  } satisfies ProblemDetails;
}

const REPOSITORY = /^\/api\/projects\/([^/]+)\/repository(\/fetch)?$/;

/**
 * The Agents page's API behind `fetch`: the definitions Repository read, the Project create and
 * the Project with its Repository (read, connect, fetch). `initial` is the server's state: no
 * Project (`null`), or the Project with its Repository (`null` until connected).
 */
export function fakeAgentsApi(initial: { repository: RepositoryOutput | null } | null) {
  let project: ProjectOutput | null = initial ? DEFINITIONS_PROJECT : null;
  let repository: RepositoryOutput | null = initial?.repository ?? null;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const scripted: { status: number; body: unknown }[] = [];

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    // A body-less POST (the fetch command) has no JSON to read.
    const text = request.method === 'POST' || request.method === 'PUT' ? await request.text() : '';
    const body: unknown = text ? JSON.parse(text) : undefined;
    calls.push({ method: request.method, path: pathname, body });
    const response = request.method === 'GET' ? scripted.shift() : undefined;
    if (response) return json(response.status, response.body);

    if (pathname === '/api/agents/definitions-repository') {
      return json(200, {
        project: project && {
          id: project.id,
          repository: repository && {
            state: repository.state,
            integrationBranch: repository.integrationBranch,
            headSha: repository.headSha ?? null,
            lastFetchedAt: repository.lastFetchedAt ?? null,
          },
        },
      });
    }
    if (pathname === '/api/projects' && request.method === 'POST') {
      const scriptedPost = scripted.shift();
      if (scriptedPost) return json(scriptedPost.status, scriptedPost.body);
      project = { ...DEFINITIONS_PROJECT, name: (body as { name: string }).name };
      return json(201, project);
    }
    if (project && pathname === `/api/projects/${project.id}`) {
      return json(200, {
        ...project,
        repository: repository && {
          state: repository.state,
          url: repository.url,
          integrationBranch: repository.integrationBranch,
        },
      });
    }
    const match = REPOSITORY.exec(pathname);
    if (project && match?.[1] === project.id) {
      if (match[2] === '/fetch' && repository) {
        repository = { ...repository, state: 'fetching' };
        return json(202, repository);
      }
      if (request.method === 'POST') {
        const { url, integrationBranch } = body as { url: string; integrationBranch: string };
        repository = {
          state: 'awaiting_key',
          url,
          integrationBranch,
          hasClone: false,
          publicKey: 'ssh-ed25519 c3ludGhldGlj studio-Agent-definitions',
        };
        return json(201, repository);
      }
      return repository ? json(200, repository) : json(404, problem(404, 'No repository'));
    }
    return json(404, problem(404, 'Not Found'));
  });
  vi.stubGlobal('fetch', fetch);

  return {
    /** The Repository as the server holds it. */
    get repository() {
      return repository;
    },
    /** The requests the page made, in order. */
    calls: () => calls,
    /** The next read (or, for a create, the next POST) gets this response. */
    respondNext(status: number, body: unknown) {
      scripted.push({ status, body });
    },
  };
}

function json(status: number, body: unknown): Response {
  const contentType = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}
