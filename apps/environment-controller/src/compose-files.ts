import type { ComposeStack } from '@agentic-studio/compose-validation';
import { stringify } from 'yaml';
import { ownershipLabels } from './ownership.js';

/** The cgroup parent of a Preview: its own systemd slice. */
export const sliceName = (composeProject: string) => `${composeProject}.slice`;

/** The validated stack, serialised: the only service definition Compose is given. */
export function renderStack(stack: ComposeStack): string {
  return stringify(stack, { lineWidth: 0 });
}

function keysOf(value: unknown): string[] {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

function buildsImage(services: unknown, name: string): boolean {
  if (typeof services !== 'object' || services === null) return false;
  const service: unknown = (services as Record<string, unknown>)[name];
  return typeof service === 'object' && service !== null && 'build' in service;
}

/**
 * What the controller forces on top of the stack: every service runs in the Preview's slice and
 * is never restarted, and services, networks, volumes and built images carry both ownership
 * labels; the long `build` form merges with the short one.
 */
export function renderOverride(
  stack: ComposeStack,
  identity: { composeProject: string; projectId: string },
): string {
  const labels = ownershipLabels(identity.projectId);
  const services = Object.fromEntries(
    keysOf(stack.services).map((name) => [
      name,
      {
        cgroup_parent: sliceName(identity.composeProject),
        restart: 'no',
        labels,
        ...(buildsImage(stack.services, name) ? { build: { labels } } : {}),
      },
    ]),
  );
  const networks = Object.fromEntries(
    ['default', ...keysOf(stack.networks)].map((name) => [name, { labels }]),
  );
  const volumes = Object.fromEntries(keysOf(stack.volumes).map((name) => [name, { labels }]));
  return stringify(
    { services, networks, ...(Object.keys(volumes).length > 0 ? { volumes } : {}) },
    { lineWidth: 0 },
  );
}
