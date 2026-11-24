import 'reflect-metadata';
import { type DynamicModule, RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { IS_CONTROLLER_ROUTE } from '../platform/auth/controller-route.js';
import { IS_PUBLIC } from '../platform/auth/public.decorator.js';
import { IS_WORKER_ROUTE } from '../platform/auth/worker-route.js';
import { testConfig } from './test-config.js';

type Controller = new (...args: never[]) => object;

/** A guard class declared with `@UseGuards` on a class or a method, by name. */
function guards(target: object): string[] {
  const found: unknown = Reflect.getMetadata('__guards__', target);
  return Array.isArray(found) ? found.map((guard: { name: string }) => guard.name) : [];
}

/** A marker set on the method or the class, the method first, as `SessionGuard` reads it. */
function flag(key: symbol, handler: object, controller: object): boolean {
  const onMethod: unknown = Reflect.getMetadata(key, handler);
  return (onMethod ?? Reflect.getMetadata(key, controller)) === true;
}

/** One line per route: `METHOD /path [flags; guards]`, read from the Nest decorator metadata. */
function routes(controllers: Controller[]): string[] {
  return controllers
    .flatMap((controller) => {
      const base = String(Reflect.getMetadata('path', controller));
      return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') return [];
        const method: unknown = Reflect.getMetadata('method', handler);
        if (typeof method !== 'number') return [];
        const path = String(Reflect.getMetadata('path', handler));
        const worker = flag(IS_WORKER_ROUTE, handler, controller);
        const environmentController = flag(IS_CONTROLLER_ROUTE, handler, controller);
        const isPublic = flag(IS_PUBLIC, handler, controller);
        const flags = [
          environmentController ? 'controller-token' : worker ? 'worker-token' : 'session',
          ...(isPublic ? ['public'] : []),
          ...guards(controller).map((guard) => `class-guard:${guard}`),
          ...guards(handler).map((guard) => `guard:${guard}`),
        ];
        const full = `/api/${base}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
        return [`${RequestMethod[method]} ${full} [${flags.join(', ')}]`];
      });
    })
    .sort();
}

describe('route and guard inventory', () => {
  it('lists every route of projects, executions and environments with its authentication and guards', () => {
    // Reached through the composition root: nothing outside a module imports its internals.
    // Only the three business modules are listed; the platform's controllers are not.
    const modules = (AppModule.register(testConfig()).imports ?? []).filter(
      (entry): entry is DynamicModule =>
        'module' in entry &&
        ['ProjectsModule', 'ExecutionsModule', 'EnvironmentsModule'].includes(entry.module.name),
    );
    expect(modules).toHaveLength(3);
    const controllers = modules.flatMap((entry) => entry.controllers ?? []);
    expect(routes(controllers as Controller[])).toMatchInlineSnapshot(`
      [
        "DELETE /api/projects/:id/environment-file [session]",
        "DELETE /api/projects/:id/preview/settings [session]",
        "DELETE /api/projects/:id/repository [session]",
        "DELETE /api/runs/:runId/pull-request/failing-checks/prepared [session]",
        "GET /api/agent-worker [session]",
        "GET /api/controller/operations/:operationId/source [controller-token]",
        "GET /api/projects [session]",
        "GET /api/projects/:id [session]",
        "GET /api/projects/:id/environment-file [session]",
        "GET /api/projects/:id/preview [session]",
        "GET /api/projects/:id/preview/builds/:buildId/events [session]",
        "GET /api/projects/:id/repository [session]",
        "GET /api/projects/:id/runs [session]",
        "GET /api/providers [session]",
        "GET /api/runs [session]",
        "GET /api/runs/:runId [session]",
        "GET /api/runs/:runId/diff [session]",
        "GET /api/runs/:runId/diff/file [session]",
        "GET /api/runs/:runId/events [session]",
        "GET /api/runs/:runId/events/stream [session]",
        "GET /api/runs/:runId/merge-review [session]",
        "GET /api/runs/:runId/merge-review/file [session]",
        "GET /api/runs/:runId/pull-request/failing-checks/prepared [session]",
        "GET /api/runs/:runId/pull-request/review-comments [session]",
        "GET /api/runs/:runId/steps [session]",
        "GET /api/runs/summary [session]",
        "POST /api/controller/operations/:operationId/log [controller-token]",
        "POST /api/controller/operations/:operationId/state [controller-token]",
        "POST /api/controller/operations/claim [controller-token]",
        "POST /api/projects [session]",
        "POST /api/projects/:id/preview/builds [session]",
        "POST /api/projects/:id/repository [session]",
        "POST /api/projects/:id/repository/fetch [session]",
        "POST /api/projects/:id/repository/verify [session]",
        "POST /api/projects/:id/runs [session]",
        "POST /api/runs/:runId/answer [session]",
        "POST /api/runs/:runId/bring-up-to-date [session]",
        "POST /api/runs/:runId/cancel [session]",
        "POST /api/runs/:runId/follow-up [session]",
        "POST /api/runs/:runId/merge [session]",
        "POST /api/runs/:runId/merge-review [session]",
        "POST /api/runs/:runId/pull-request/close [session]",
        "POST /api/runs/:runId/pull-request/failing-checks/prepare [session]",
        "POST /api/runs/:runId/pull-request/refresh [session]",
        "POST /api/runs/:runId/pull-request/review-comments/load [session]",
        "POST /api/runs/:runId/resume [session]",
        "POST /api/runs/:runId/retry-delivery [session]",
        "POST /api/worker/lookups/:lookupId/result [worker-token]",
        "POST /api/worker/lookups/claim [worker-token]",
        "POST /api/worker/runs/:runId/diff [worker-token]",
        "POST /api/worker/runs/:runId/events [worker-token]",
        "POST /api/worker/runs/:runId/heartbeat [worker-token]",
        "POST /api/worker/runs/:runId/state [worker-token]",
        "POST /api/worker/runs/:runId/steps [worker-token]",
        "POST /api/worker/runs/claim [worker-token]",
        "POST /api/worker/runs/states [worker-token]",
        "POST /api/worker/status [worker-token]",
        "PUT /api/projects/:id/environment-file [session]",
        "PUT /api/projects/:id/merge-method [session]",
        "PUT /api/projects/:id/preview/settings [session]",
      ]
    `);
  });
});
