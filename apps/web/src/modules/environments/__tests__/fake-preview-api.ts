import { vi } from 'vitest';
import type {
  PreviewBuildEventsOutput,
  PreviewBuildOutput,
  PreviewOutput,
  PreviewRefusal,
  ProblemDetails,
} from '../../../platform/api';

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

export const BUILD_ID = '7c1d9a52-3b1e-4f6a-8a2d-5e4f3a2b1c0d';
export const COMMIT = '0123456789abcdef0123456789abcdef01234567';

export const QUEUED_BUILD: PreviewBuildOutput = {
  id: BUILD_ID,
  commit: COMMIT,
  status: 'queued',
  requestedAt: '2026-11-24T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  timeLimitMinutes: 20,
  failure: null,
  log: { bytes: 0, truncated: false },
};

export function logLine(
  seq: number,
  text: string,
  extras: Partial<PreviewBuildEventsOutput['events'][number]> = {},
): PreviewBuildEventsOutput['events'][number] {
  return {
    seq,
    at: '2026-11-24T10:00:01.000Z',
    stream: 'build',
    text,
    truncated: false,
    redacted: false,
    ...extras,
  };
}

/**
 * A fake of the Preview API behind `fetch`: `state` is what the server keeps, and a test scripts
 * the answer of the next save, removal, build request or log read with `respondNext`.
 */
export function fakePreviewApi(
  initial: {
    settings?: Settings | null;
    hostname?: string | null;
    repository?: PreviewOutput['repository'];
    controllerConnected?: boolean;
    running?: PreviewOutput['running'];
    latestBuild?: PreviewBuildOutput | null;
    state?: PreviewOutput['state'];
  } = {},
) {
  const state = {
    settings: initial.settings ?? null,
    hostname:
      initial.hostname === undefined ? 'preview-3f2b8c1e4d5a.example.test' : initial.hostname,
    repository: initial.repository ?? { ready: true },
    controllerConnected: initial.controllerConnected ?? true,
    running: initial.running ?? null,
    latestBuild: initial.latestBuild ?? null,
    stateOverride: initial.state ?? null,
    /** The log of each build id, in order; a page is cut from it by `after` and `limit`. */
    logs: new Map<string, PreviewBuildEventsOutput['events']>(),
    finalBuilds: new Set<string>(),
    logTruncated: false,
    /** While set, a build request waits for it before it answers. */
    buildGate: null as Promise<void> | null,
  };
  const saves: unknown[] = [];
  const removes: number[] = [];
  const builds: number[] = [];
  const eventRequests: { buildId: string; after: number; limit: number }[] = [];
  const scripted: { status: number; body: unknown }[] = [];

  function preview(): PreviewOutput {
    return {
      settings: state.settings,
      hostname: state.hostname,
      ...(state.hostname === null ? { hostnameUnavailable: 'not_configured' as const } : {}),
      repository: state.repository,
      state:
        state.stateOverride ??
        (state.settings === null ? ('not_configured' as const) : ('stopped' as const)),
      running: state.running,
      latestBuild: state.latestBuild,
      latestChange: null,
      controller: { connected: state.controllerConnected },
    };
  }

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const { pathname, searchParams } = new URL(request.url);
    const buildRoute = /^\/api\/projects\/([^/]+)\/preview\/builds(?:\/([^/]+)\/events)?$/.exec(
      pathname,
    );
    if (buildRoute) {
      if (buildRoute[1] !== PROJECT_ID) return json(404, problem(404, 'Project not found'));
      const scriptedAnswer = scripted.shift();
      if (buildRoute[2] === undefined) {
        builds.push(Date.now());
        await state.buildGate;
        if (scriptedAnswer) return json(scriptedAnswer.status, scriptedAnswer.body);
        state.latestBuild = { ...QUEUED_BUILD };
        state.stateOverride = 'building';
        return json(202, state.latestBuild);
      }
      const after = Number(searchParams.get('after') ?? 0);
      const limit = Number(searchParams.get('limit') ?? 500);
      eventRequests.push({ buildId: buildRoute[2], after, limit });
      if (scriptedAnswer) return json(scriptedAnswer.status, scriptedAnswer.body);
      const all = state.logs.get(buildRoute[2]);
      if (!all) return json(404, problem(404, 'Build not found'));
      const rest = all.filter((event) => event.seq > after);
      const events = rest.slice(0, limit);
      const more = rest.length > events.length;
      const page: PreviewBuildEventsOutput = {
        events,
        ...(more ? { next: events.at(-1)!.seq } : {}),
        final: state.finalBuilds.has(buildRoute[2]),
        truncated: state.logTruncated,
      };
      return json(200, page);
    }
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
    fetch,
    saves,
    removes,
    builds,
    eventRequests,
    /** The next save, removal, build request or log read gets this response instead. */
    respondNext(status: number, body: unknown) {
      scripted.push({ status, body });
    },
    respondNextSave(status: number, body: unknown) {
      scripted.push({ status, body });
    },
  };
}
