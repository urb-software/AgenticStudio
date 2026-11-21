import 'reflect-metadata';
import type { DynamicModule, Provider, Type } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { IS_WORKER_ROUTE } from '../platform/auth/worker-route.js';
import { testConfig } from './test-config.js';

// Reached through the composition root, as route-inventory.test.ts does: nothing outside a
// module imports its internals, so tokens are named by their symbol description.

type Token = unknown;

const describes = (token: Token, name: string) =>
  typeof token === 'symbol' && token.description === name;
const isMergeHost = (token: Token) =>
  describes(token, 'MERGE_HOST') ||
  (typeof token === 'function' && ['GitHubMergeHost', 'InMemoryMergeHost'].includes(token.name));

function executions() {
  const module = (AppModule.register(testConfig()).imports ?? []).find(
    (entry): entry is DynamicModule =>
      'module' in entry && entry.module.name === 'ExecutionsModule',
  );
  if (!module) throw new Error('ExecutionsModule is not registered');
  return { controllers: (module.controllers ?? []) as Type[], providers: module.providers ?? [] };
}

function injectedTokens(target: Type): Token[] {
  const typed: Token[] = Reflect.getMetadata('design:paramtypes', target) ?? [];
  const explicit: { index: number; param: Token }[] =
    Reflect.getMetadata('self:paramtypes', target) ?? [];
  const tokens = [...typed];
  for (const { index, param } of explicit) tokens[index] = param;
  return tokens;
}

function providerToken(provider: Provider): Token {
  return typeof provider === 'function' ? provider : (provider as { provide: Token }).provide;
}

/** Every token a class needs, directly or through the providers that satisfy them. */
function reachableFrom(root: Type, providers: Provider[]): Set<Token> {
  const byToken = new Map(providers.map((provider) => [providerToken(provider), provider]));
  const reached = new Set<Token>();
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (reached.has(token)) continue;
      reached.add(token);
      const provider = byToken.get(token);
      if (provider === undefined) continue;
      if (typeof provider === 'function') visit(injectedTokens(provider as Type));
      else if ('useExisting' in provider) visit([provider.useExisting]);
      else if ('useClass' in provider) visit(injectedTokens(provider.useClass as Type));
      else if ('useFactory' in provider) visit((provider.inject ?? []) as Token[]);
    }
  };
  visit(injectedTokens(root));
  return reached;
}

describe('the Merge credential and the agent worker', () => {
  const { controllers, providers } = executions();
  const workerControllers = controllers.filter(
    (controller) => Reflect.getMetadata(IS_WORKER_ROUTE, controller) === true,
  );

  it('finds the worker routes and a merge host for operator features', () => {
    expect(workerControllers.length).toBeGreaterThanOrEqual(10);
    expect(providers.some((provider) => describes(providerToken(provider), 'MERGE_HOST'))).toBe(
      true,
    );
  });

  it.each(workerControllers.map((controller) => [controller.name, controller] as const))(
    '%s cannot resolve the merge host, directly or through a handler',
    (_name, controller) => {
      const reached = reachableFrom(controller, providers);
      expect(reached.size).toBeGreaterThan(0);
      expect([...reached].filter(isMergeHost)).toEqual([]);
    },
  );

  it('walks far enough to see a repository behind the worker routes', () => {
    const all = workerControllers.flatMap((controller) => [
      ...reachableFrom(controller, providers),
    ]);
    expect(all.some((token) => describes(token, 'RUN_REPOSITORY'))).toBe(true);
  });

  it('finds the merge host when an operator feature has it injected', () => {
    class OperatorFeature {}
    Reflect.defineMetadata('design:paramtypes', [Object], OperatorFeature);
    Reflect.defineMetadata(
      'self:paramtypes',
      [
        {
          index: 0,
          param: providerToken(providers.find((p) => describes(providerToken(p), 'MERGE_HOST'))!),
        },
      ],
      OperatorFeature,
    );
    expect([...reachableFrom(OperatorFeature, providers)].some(isMergeHost)).toBe(true);
  });
});
