import { validateCompose } from '@agentic-studio/compose-validation';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { composeEnvironment, parseEnvironmentFile } from '../compose-environment.js';
import { renderOverride, renderStack, sliceName } from '../compose-files.js';

const PROJECT = '8f14e45f-ceea-467a-9575-1a3a8b1c0f10';
const COMPOSE_PROJECT = 'preview-8f14e45fceea467a95751a3a8b1c0f10';
const BASE = {
  PATH: '/usr/bin',
  HOME: '/data/home',
  DOCKER_CONFIG: '/data/docker-config',
  DOCKER_HOST: 'unix:///run/user/2002/docker.sock',
  XDG_RUNTIME_DIR: '/run/user/2002',
};

describe('parseEnvironmentFile', () => {
  it('reads plain, exported, quoted and commented values', () => {
    const pairs = parseEnvironmentFile(
      [
        '# a comment',
        '',
        'PLAIN=value',
        'export EXPORTED = spaced',
        'DOUBLE="a b # not a comment"',
        'ESCAPED="line\\nbreak \\"quoted\\""',
        "SINGLE='raw \\n $HOME'",
        'TRAILING=value # a comment',
        'EMPTY=',
        'not a pair',
      ].join('\n'),
    );
    expect(pairs).toEqual({
      PLAIN: 'value',
      EXPORTED: 'spaced',
      DOUBLE: 'a b # not a comment',
      ESCAPED: 'line\nbreak "quoted"',
      SINGLE: 'raw \\n $HOME',
      TRAILING: 'value',
      EMPTY: '',
    });
  });
});

describe('composeEnvironment', () => {
  it('is the fixed base plus the Environment file values, nothing from the controller', () => {
    process.env.STUDIO_CONTROLLER_TOKEN_FOR_TEST = 'must-not-appear';
    const { env, dropped } = composeEnvironment(BASE, 'DB_PASSWORD=pw\nAPP_MODE=prod\n');
    expect(env).toEqual({ ...BASE, DB_PASSWORD: 'pw', APP_MODE: 'prod' });
    expect(dropped).toEqual([]);
    delete process.env.STUDIO_CONTROLLER_TOKEN_FOR_TEST;
  });

  it('has only the base without an Environment file', () => {
    expect(composeEnvironment(BASE, null)).toEqual({ env: BASE, dropped: [] });
  });

  it('drops keys that steer Compose, Docker, BuildKit or the loader, and the base keys', () => {
    const file = [
      'COMPOSE_FILE=/etc/passwd',
      'COMPOSE_PROJECT_NAME=other',
      'DOCKER_HOST=tcp://evil',
      'DOCKER_CONFIG=/tmp/x',
      'BUILDKIT_HOST=x',
      'BUILDX_BUILDER=x',
      'LD_PRELOAD=/tmp/x.so',
      'PATH=/tmp/bin',
      'HOME=/root',
      'XDG_RUNTIME_DIR=/tmp',
      'bad-key=1',
      'KEEP=1',
    ].join('\n');
    const { env, dropped } = composeEnvironment(BASE, file);
    expect(env).toEqual({ ...BASE, KEEP: '1' });
    expect(dropped.sort()).toEqual(
      [
        'COMPOSE_FILE',
        'COMPOSE_PROJECT_NAME',
        'DOCKER_HOST',
        'DOCKER_CONFIG',
        'BUILDKIT_HOST',
        'BUILDX_BUILDER',
        'LD_PRELOAD',
        'PATH',
        'HOME',
        'XDG_RUNTIME_DIR',
        'bad-key',
      ].sort(),
    );
  });

  it('never reports a dropped value, only names', () => {
    const { dropped } = composeEnvironment(BASE, 'COMPOSE_FILE=secret-value');
    expect(JSON.stringify(dropped)).not.toContain('secret-value');
  });
});

const STACK_TEXT = `
services:
  web:
    image: nginx:1.27
    networks: [front]
    volumes: [data:/data]
  worker:
    image: busybox
networks:
  front: {}
volumes:
  data:
`;

function acceptedStack() {
  const result = validateCompose({ text: STACK_TEXT, entryService: 'web', entryPort: 80 });
  if (result.status !== 'accepted') throw new Error('fixture refused');
  return result.stack;
}

describe('the Compose files', () => {
  it('serialises the validated stack', () => {
    expect(parse(renderStack(acceptedStack()))).toEqual(acceptedStack());
  });

  it('forces the slice, no restart and both labels on every service, network and volume', () => {
    const override = parse(
      renderOverride(acceptedStack(), {
        composeProject: COMPOSE_PROJECT,
        projectId: PROJECT,
      }),
    ) as Record<string, Record<string, Record<string, unknown>>>;
    const labels = {
      'io.agentic-studio.owner': 'environment-controller',
      'io.agentic-studio.project': PROJECT,
    };
    expect(override.services).toEqual({
      web: { cgroup_parent: `${COMPOSE_PROJECT}.slice`, restart: 'no', labels },
      worker: { cgroup_parent: `${COMPOSE_PROJECT}.slice`, restart: 'no', labels },
    });
    expect(override.networks).toEqual({ default: { labels }, front: { labels } });
    expect(override.volumes).toEqual({ data: { labels } });
  });

  it('labels the image of every service that builds, whatever the build syntax', () => {
    const stack = {
      services: {
        long: { build: { context: './app' } },
        short: { build: './app' },
        pulled: { image: 'nginx:1.27' },
      },
    };
    const override = parse(
      renderOverride(stack, { composeProject: COMPOSE_PROJECT, projectId: PROJECT }),
    ) as Record<string, Record<string, Record<string, unknown>>>;
    const labels = {
      'io.agentic-studio.owner': 'environment-controller',
      'io.agentic-studio.project': PROJECT,
    };

    expect(override.services!.long).toMatchObject({ build: { labels } });
    expect(override.services!.short).toMatchObject({ build: { labels } });
    expect(override.services!.pulled).not.toHaveProperty('build');
  });

  it('labels the default network and leaves volumes out when there are none', () => {
    const stack = { services: { a: { image: 'x' } } };
    const override = parse(
      renderOverride(stack, { composeProject: COMPOSE_PROJECT, projectId: PROJECT }),
    );
    expect(Object.keys(override.networks)).toEqual(['default']);
    expect(override).not.toHaveProperty('volumes');
  });

  it('names the slice after the Compose project', () => {
    expect(sliceName(COMPOSE_PROJECT)).toBe(`${COMPOSE_PROJECT}.slice`);
  });
});
