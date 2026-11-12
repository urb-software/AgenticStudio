import { vi } from 'vitest';
import type { ProblemDetails, ProjectOutput } from '../../../platform/api';

interface ScriptedResponse {
  status: number;
  body: unknown;
}

/**
 * A fake `/api/projects` behind `fetch`, the boundary the generated client calls, so the
 * real client, wrapper and TanStack Query run in the tests. It keeps the API's contract
 * (newest first, 201 with the project) without its rules; tests script error responses.
 */
export function fakeProjectsApi(initial: ProjectOutput[] = []) {
  const projects = [...initial];
  const scripted: Record<'GET' | 'POST', ScriptedResponse[]> = { GET: [], POST: [] };
  const calls: { method: string; body: unknown }[] = [];
  let nextId = 1;

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const method = request.method as 'GET' | 'POST';
    const body: unknown = method === 'POST' ? await request.json() : undefined;
    calls.push({ method, body });
    if (pathname !== '/api/projects') {
      return json(404, problem(404, 'Not Found'));
    }
    const response = scripted[method].shift();
    if (response) {
      return json(response.status, response.body);
    }
    if (method === 'GET') {
      return json(200, { items: [...projects] });
    }
    const created: ProjectOutput = {
      id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
      name: (body as { name: string }).name,
      createdAt: new Date(Date.UTC(2026, 10, 12, 12, nextId)).toISOString(),
    };
    projects.unshift(created);
    return json(201, created);
  });
  vi.stubGlobal('fetch', fetch);

  return {
    /** Requests by method, in order. */
    calls: (method: 'GET' | 'POST') => calls.filter((call) => call.method === method),
    /** The next request with `method` gets this response instead of the default. */
    respondNext(method: 'GET' | 'POST', status: number, body: unknown) {
      scripted[method].push({ status, body });
    },
  };
}

export function problem(
  status: number,
  title: string,
  errors?: ProblemDetails['errors'],
): ProblemDetails {
  return {
    type: 'about:blank',
    title,
    status,
    detail: `${title} (test)`,
    correlationId: '00000000-0000-4000-8000-000000000000',
    ...(errors ? { errors } : {}),
  };
}

function json(status: number, body: unknown): Response {
  const contentType = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}
