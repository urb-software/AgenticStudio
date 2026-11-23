import { vi } from 'vitest';
import type { PreviewOutput, PreviewRefusal, ProblemDetails } from '../../../platform/api';

type Settings = NonNullable<PreviewOutput['settings']>;

export const PROJECT_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

export function problem(
  status: number,
  title: string,
  extras: Partial<ProblemDetails> & { refusals?: PreviewRefusal[] } = {},
): ProblemDetails {
  return {
    type: 'about:blank',
    title,
    status,
    detail: `${title} (test)`,
    correlationId: '00000000-0000-4000-8000-000000000000',
    ...extras,
  };
}

function json(status: number, body: unknown): Response {
  const contentType = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

/**
 * A fake of the Preview API behind `fetch`: `state` is what the server keeps, and a test scripts
 * the answer of the next save with `respondNextSave`.
 */
export function fakePreviewApi(
  initial: {
    settings?: Settings | null;
    hostname?: string | null;
    repository?: PreviewOutput['repository'];
  } = {},
) {
  const state = {
    settings: initial.settings ?? null,
    hostname:
      initial.hostname === undefined ? 'preview-3f2b8c1e4d5a.example.test' : initial.hostname,
    repository: initial.repository ?? { ready: true },
  };
  const saves: unknown[] = [];
  const removes: number[] = [];
  const scripted: { status: number; body: unknown }[] = [];

  function preview(): PreviewOutput {
    return {
      settings: state.settings,
      hostname: state.hostname,
      ...(state.hostname === null ? { hostnameUnavailable: 'not_configured' as const } : {}),
      repository: state.repository,
    };
  }

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const match = /^\/api\/projects\/([^/]+)\/preview(\/settings)?$/.exec(pathname);
    if (!match) return json(404, problem(404, 'Not Found'));
    if (match[1] !== PROJECT_ID) return json(404, problem(404, 'Project not found'));
    if (!match[2]) return json(200, preview());
    if (request.method === 'DELETE') {
      removes.push(Date.now());
      const failure = scripted.shift();
      if (failure) return json(failure.status, failure.body);
      state.settings = null;
      return new Response(null, { status: 204 });
    }
    const body = (await request.json()) as { composeFile: string; service: string; port: number };
    saves.push(body);
    const response = scripted.shift();
    if (response) return json(response.status, response.body);
    state.settings = { ...body, updatedAt: '2026-11-23T12:00:00.000Z' };
    return json(200, preview());
  });
  vi.stubGlobal('fetch', fetch);

  return {
    state,
    saves,
    removes,
    /** The next save or removal gets this response instead of the default. */
    respondNext(status: number, body: unknown) {
      scripted.push({ status, body });
    },
    respondNextSave(status: number, body: unknown) {
      scripted.push({ status, body });
    },
  };
}
