import 'reflect-metadata';
import { createHash, createSecretKey, randomBytes } from 'node:crypto';
import {
  type DynamicModule,
  type ExecutionContext,
  HttpException,
  RequestMethod,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { IS_CONTROLLER_ROUTE } from '../platform/auth/controller-route.js';
import type { HttpRequest } from '../platform/auth/http-types.js';
import { IS_PUBLIC } from '../platform/auth/public.decorator.js';
import { MutationOriginGuard } from '../platform/auth/mutation-origin.guard.js';
import { SessionCookie } from '../platform/auth/session-cookie.js';
import { SessionGuard } from '../platform/auth/session.guard.js';
import { SessionStore } from '../platform/auth/session-store.js';
import { IS_WORKER_ROUTE } from '../platform/auth/worker-route.js';
import { testConfig } from './test-config.js';

// Throwaway tokens generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const CONTROLLER_TOKEN = randomBytes(32).toString('base64');
const digest = (token: string) => createSecretKey(createHash('sha256').update(token).digest());

const config = testConfig({
  workerToken: digest(WORKER_TOKEN),
  controllerToken: digest(CONTROLLER_TOKEN),
});
const cookie = new SessionCookie(config);
const sessions = { touch: async (id: string) => id === 'valid-session' } as unknown as SessionStore;
const reflector = new Reflector();
const sessionGuard = new SessionGuard(reflector, cookie, sessions, config);
const originGuard = new MutationOriginGuard(config, reflector);

type Controller = new (...args: never[]) => object;
type Kind = 'controller' | 'worker' | 'operator';

interface Route {
  label: string;
  kind: Kind;
  method: string;
  controller: Controller;
  handler: (...args: never[]) => unknown;
}

function flag(key: symbol, handler: object, controller: object): boolean {
  const onMethod: unknown = Reflect.getMetadata(key, handler);
  return (onMethod ?? Reflect.getMetadata(key, controller)) === true;
}

function controllersOf(entry: unknown): Controller[] {
  if (typeof entry === 'function') {
    const declared: unknown = Reflect.getMetadata('controllers', entry);
    return Array.isArray(declared) ? (declared as Controller[]) : [];
  }
  if (typeof entry === 'object' && entry !== null && 'module' in entry) {
    const dynamic = entry as DynamicModule;
    return [...controllersOf(dynamic.module), ...((dynamic.controllers ?? []) as Controller[])];
  }
  return [];
}

/** Every controller of every module the composition root imports, platform ones included. */
function allRoutes(): Route[] {
  const controllers = (AppModule.register(testConfig()).imports ?? []).flatMap(controllersOf);
  return controllers.flatMap((controller) => {
    const base = String(Reflect.getMetadata('path', controller));
    return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
      const handler = (controller.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') return [];
      const method: unknown = Reflect.getMetadata('method', handler);
      if (typeof method !== 'number') return [];
      if (flag(IS_PUBLIC, handler, controller)) return [];
      const kind: Kind = flag(IS_CONTROLLER_ROUTE, handler, controller)
        ? 'controller'
        : flag(IS_WORKER_ROUTE, handler, controller)
          ? 'worker'
          : 'operator';
      const path = `/api/${base}/${String(Reflect.getMetadata('path', handler))}`
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');
      const verb = RequestMethod[method]!;
      return [
        {
          label: `${verb} ${path}`,
          kind,
          method: verb,
          controller,
          handler: handler as Route['handler'],
        },
      ];
    });
  });
}

type Credential = 'controller token' | 'worker token' | 'session' | 'nothing';

const CREDENTIAL_HEADERS: Record<Credential, Record<string, string>> = {
  'controller token': { authorization: `Bearer ${CONTROLLER_TOKEN}` },
  'worker token': { authorization: `Bearer ${WORKER_TOKEN}` },
  session: { cookie: `${cookie.name}=valid-session`, origin: config.studioOrigin },
  nothing: {},
};

const ACCEPTED: Record<Kind, Credential> = {
  controller: 'controller token',
  worker: 'worker token',
  operator: 'session',
};

async function outcome(route: Route, credential: Credential): Promise<number> {
  const request = {
    method: route.method,
    headers: { 'content-type': 'application/json', ...CREDENTIAL_HEADERS[credential] },
  } as unknown as HttpRequest;
  const context = {
    getHandler: () => route.handler,
    getClass: () => route.controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  try {
    originGuard.canActivate(context);
    await sessionGuard.canActivate(context);
    return 200;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe('token matrix over every route', () => {
  const routes = allRoutes();
  const controllerRoutes = routes.filter((route) => route.kind === 'controller');

  it('finds controller, worker and operator routes, platform ones included', () => {
    expect(routes.some((route) => route.label.includes('/api/auth/'))).toBe(true);
    expect(new Set(routes.map((route) => route.kind))).toEqual(
      new Set(['controller', 'worker', 'operator']),
    );
    expect(controllerRoutes.length).toBeGreaterThanOrEqual(4);
  });

  it('marks exactly the routes under /api/controller/ as controller routes', () => {
    for (const route of routes) {
      expect(route.kind === 'controller', route.label).toBe(
        route.label.includes(' /api/controller/'),
      );
    }
  });

  it.each(['controller', 'worker', 'operator'] as const)(
    'answers a %s route only to its own credential',
    async (kind) => {
      for (const route of routes.filter((candidate) => candidate.kind === kind)) {
        for (const credential of Object.keys(CREDENTIAL_HEADERS) as Credential[]) {
          const status = await outcome(route, credential);
          if (credential === ACCEPTED[kind]) {
            expect(status, `${route.label} with ${credential}`).toBe(200);
          } else {
            expect([401, 403], `${route.label} with ${credential}`).toContain(status);
          }
        }
      }
    },
  );

  it('answers 401 on every controller route to the worker token, a session or nothing', async () => {
    for (const route of controllerRoutes) {
      for (const credential of ['worker token', 'session', 'nothing'] as const) {
        expect(await outcome(route, credential), `${route.label} with ${credential}`).toBe(401);
      }
    }
  });

  it('answers the routes that pass a Checkpoint to a session only, never to the worker token', async () => {
    const checkpoint = routes.filter((route) => route.label.includes('/checkpoint/'));
    expect(checkpoint.map((route) => route.label).sort()).toEqual([
      'POST /api/runs/:runId/checkpoint/continue',
      'POST /api/runs/:runId/checkpoint/stop',
    ]);
    for (const route of checkpoint) {
      expect(route.kind).toBe('operator');
      for (const credential of ['worker token', 'controller token', 'nothing'] as const) {
        expect([401, 403], `${route.label} with ${credential}`).toContain(
          await outcome(route, credential),
        );
      }
      expect(await outcome(route, 'session')).toBe(200);
    }
  });

  it('gives the agent worker no route that names a Checkpoint', () => {
    const worker = routes.filter((route) => route.kind === 'worker');
    expect(worker.length).toBeGreaterThan(0);
    expect(worker.filter((route) => /checkpoint/i.test(route.label))).toEqual([]);
  });

  it('answers the publish route, the write to a Repository, to a session only', async () => {
    const publish = routes.find(
      (route) => route.label === 'POST /api/agents/definitions-repository/draft/publish',
    );
    expect(publish?.kind).toBe('operator');
    for (const credential of ['worker token', 'controller token', 'nothing'] as const) {
      expect([401, 403], `publish with ${credential}`).toContain(
        await outcome(publish!, credential),
      );
    }
    expect(await outcome(publish!, 'session')).toBe(200);
    // A session without the Studio Origin is refused too: a publish is a mutation.
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${cookie.name}=valid-session` },
    } as unknown as HttpRequest;
    const context = {
      getHandler: () => publish!.handler,
      getClass: () => publish!.controller,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    expect(() => originGuard.canActivate(context)).toThrow(HttpException);
  });

  it('fails closed on controller routes while no controller token is configured', async () => {
    const closed = new SessionGuard(reflector, cookie, sessions, testConfig());
    const route = controllerRoutes[0]!;
    const request = {
      method: route.method,
      headers: CREDENTIAL_HEADERS['controller token'],
    } as unknown as HttpRequest;
    const context = {
      getHandler: () => route.handler,
      getClass: () => route.controller,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await expect(closed.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });
});
