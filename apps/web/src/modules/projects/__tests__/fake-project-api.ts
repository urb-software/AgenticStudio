import { vi } from 'vitest';
import type { ProblemDetails, ProjectOutput, RepositoryOutput } from '../../../platform/api';
import { problem } from './fake-projects-api';

interface ScriptedResponse {
  status: number;
  body: unknown;
}

type Route = 'project' | 'repository' | 'connect' | 'fetch' | 'disconnect' | 'verify';

/** A synthetic public key line for SSH connects (not key material). */
export const FAKE_PUBLIC_KEY =
  'ssh-ed25519 c3ludGhldGljLXB1YmxpYy1rZXktZm9yLXRlc3Rz studio-Acme-Shop';
/** A synthetic SHA256 fingerprint of the Git host's key. */
export const FAKE_FINGERPRINT = 'SHA256:c3ludGhldGljLWZpbmdlcnByaW50LWZvci10ZXN0cw';

const ROUTE = /^\/api\/projects\/([^/]+)(\/repository(\/fetch|\/verify)?)?$/;

/**
 * A fake of the project detail API behind `fetch` (`GET /api/projects/:id`,
 * `GET|POST|DELETE /api/projects/:id/repository`, `POST /api/projects/:id/repository/fetch` and
 * `/verify`), so the
 * generated client, the wrapper and TanStack Query run for real. `repository` is the server's
 * state; tests change it to move the Repository on (as the background clone or fetch would)
 * and script error responses.
 */
export function fakeProjectApi(project: ProjectOutput, initial: RepositoryOutput | null = null) {
  /**
   * `cleanupPending`: a disconnect cannot remove everything yet (202, `disconnecting`).
   * `hostTrusted`: verify clones at once; otherwise it asks to confirm `FAKE_FINGERPRINT`.
   */
  const state = { repository: initial, cleanupPending: false, hostTrusted: false };
  const scripted: Record<Route, ScriptedResponse[]> = {
    project: [],
    repository: [],
    connect: [],
    fetch: [],
    disconnect: [],
    verify: [],
  };
  const calls: { route: Route; body?: unknown }[] = [];
  const held: Partial<Record<Route, Promise<void>>> = {};

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const target = targetOf(request);
    const response = await answer(request, target);
    const hold = target && held[target.route];
    if (target && hold) {
      delete held[target.route];
      await hold;
    }
    return response;
  });

  /** The route and project id of a request, from one parse of its path. */
  function targetOf(request: Request): { route: Route; projectId: string } | undefined {
    const match = ROUTE.exec(new URL(request.url).pathname);
    if (!match) return undefined;
    const projectId = match[1]!;
    if (!match[2]) return { route: 'project', projectId };
    if (match[3] === '/fetch') return { route: 'fetch', projectId };
    if (match[3] === '/verify') return { route: 'verify', projectId };
    if (request.method === 'DELETE') return { route: 'disconnect', projectId };
    return { route: request.method === 'POST' ? 'connect' : 'repository', projectId };
  }

  async function answer(
    request: Request,
    target: { route: Route; projectId: string } | undefined,
  ): Promise<Response> {
    if (!target) return json(404, problem(404, 'Not Found'));
    const { route, projectId } = target;
    const body: unknown =
      route === 'connect' || route === 'verify' ? await request.json() : undefined;
    calls.push({ route, body });
    const response = scripted[route].shift();
    if (response) return json(response.status, response.body);
    if (projectId !== project.id) return json(404, problem(404, 'Project not found'));
    switch (route) {
      case 'project':
        return json(200, {
          ...project,
          repository: state.repository && {
            state: state.repository.state,
            url: state.repository.url,
            integrationBranch: state.repository.integrationBranch,
          },
        });
      case 'repository':
        return state.repository
          ? json(200, state.repository)
          : json(404, problem(404, 'No repository'));
      case 'connect': {
        const { url, integrationBranch } = body as { url: string; integrationBranch: string };
        state.repository = /^(ssh:\/\/|[^@/:]+@[^@/:]+:)/.test(url)
          ? {
              state: 'awaiting_key',
              url,
              integrationBranch,
              hasClone: false,
              publicKey: FAKE_PUBLIC_KEY,
            }
          : { state: 'connecting', url, integrationBranch, hasClone: false };
        return json(201, state.repository);
      }
      case 'verify': {
        const current = state.repository;
        if (!current) return json(404, problem(404, 'No repository'));
        const { acceptHostKeyFingerprint } = body as { acceptHostKeyFingerprint?: string };
        const verifiable =
          current.publicKey !== undefined &&
          (['awaiting_key', 'awaiting_host_key'].includes(current.state) ||
            (current.state === 'failed' && !current.hasClone));
        if (!verifiable) return json(409, problem(409, 'Nothing to verify'));
        const { failure, hostKeyFingerprint, ...rest } = current;
        void failure;
        if (acceptHostKeyFingerprint !== undefined) {
          if (current.state !== 'awaiting_host_key')
            return json(409, problem(409, 'Nothing to verify'));
          if (acceptHostKeyFingerprint !== hostKeyFingerprint) {
            return json(
              422,
              fieldProblem(422, 'Unprocessable Entity', [
                { path: 'acceptHostKeyFingerprint', message: 'The fingerprint does not match.' },
              ]),
            );
          }
          state.repository = { ...rest, state: 'connecting', hostKeyFingerprint };
          return json(202, state.repository);
        }
        state.repository =
          state.hostTrusted || hostKeyFingerprint
            ? {
                ...rest,
                ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}),
                state: 'connecting',
              }
            : { ...rest, state: 'awaiting_host_key', hostKeyFingerprint: FAKE_FINGERPRINT };
        if (current.state === 'awaiting_host_key') {
          state.repository = {
            ...rest,
            state: 'awaiting_host_key',
            hostKeyFingerprint: FAKE_FINGERPRINT,
          };
        }
        return json(202, state.repository);
      }
      case 'fetch': {
        const current = state.repository;
        if (!current) return json(404, problem(404, 'No repository'));
        if (current.state !== 'ready' && !(current.state === 'failed' && current.hasClone)) {
          return json(409, problem(409, 'Repository busy'));
        }
        const { failure, ...rest } = current;
        void failure; // a fetch clears the previous failure
        state.repository = { ...rest, state: 'fetching' };
        return json(202, state.repository);
      }
      case 'disconnect': {
        const current = state.repository;
        if (!current) return json(404, problem(404, 'No repository'));
        if (state.cleanupPending) {
          state.repository = {
            state: 'disconnecting',
            url: current.url,
            integrationBranch: current.integrationBranch,
            hasClone: false,
          };
          return json(202, state.repository);
        }
        state.repository = null;
        return new Response(null, { status: 204 });
      }
    }
  }
  vi.stubGlobal('fetch', fetch);

  return {
    state,
    /** Requests to one route, in order. */
    calls: (route: Route) => calls.filter((call) => call.route === route),
    /**
     * Holds the answer to the next request to `route` (computed when the request arrives, so
     * it reflects the state at that time) until the returned function is called.
     */
    holdNext(route: Route): () => void {
      let release!: () => void;
      held[route] = new Promise<void>((resolve) => (release = resolve));
      return () => release();
    },
    /** The next request to `route` gets this response instead of the default. */
    respondNext(route: Route, status: number, body: unknown) {
      scripted[route].push({ status, body });
    },
  };
}

export function fieldProblem(
  status: number,
  title: string,
  errors: ProblemDetails['errors'],
  detail = 'The request is invalid.',
): ProblemDetails {
  return { ...problem(status, title, errors), detail };
}

function json(status: number, body: unknown): Response {
  const contentType = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}
