import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewMergeRebuild } from '../../../../domain/entities/preview-merge-rebuild.js';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import { PreviewSettings } from '../../../../domain/entities/preview-settings.js';
import { ProjectNotFoundError } from '../../../../domain/errors/preview-settings-errors.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import { PreviewCommit } from '../../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../../domain/value-objects/preview-limits.js';
import { PreviewOperationResult } from '../../../../domain/value-objects/preview-operation-result.js';
import { PreviewOperationFailure } from '../../../../domain/value-objects/preview-operation-failure.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';
import { COMMIT, FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import { KIT_NOW, previewKit } from '../../../__tests__/preview-test-kit.js';
import { GetPreviewHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const FIRST = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const SECOND = '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21';
const minutes = (count: number) => new Date(KIT_NOW.getTime() + count * 60_000);

describe('GetPreviewHandler', () => {
  let sources: FakePreviewSources;
  let settings: InMemoryPreviewSettingsRepository;
  let domain: { domain: string | null };
  let operations: InMemoryPreviewOperationRepository;
  let kit: ReturnType<typeof previewKit>;
  let handler: GetPreviewHandler;

  beforeEach(() => {
    sources = new FakePreviewSources();
    settings = new InMemoryPreviewSettingsRepository();
    domain = { domain: 'preview.example.test' };
    operations = new InMemoryPreviewOperationRepository();
    kit = previewKit(operations, sources);
    handler = new GetPreviewHandler(sources, settings, domain, kit.states);
  });

  async function saveSettings() {
    await settings.save(
      PreviewSettings.restore({
        projectId: PROJECT,
        composeFile: 'compose.yaml',
        service: 'web',
        port: 3000,
        updatedAt: new Date(),
      }),
    );
  }

  async function build(id: string, requested: number) {
    await operations.add(
      PreviewOperation.requestBuild({
        id,
        projectId: PROJECT,
        commit: PreviewCommit.of('b'.repeat(40)),
        composeFile: PreviewComposeFile.of('compose.yaml'),
        service: PreviewService.of('web'),
        port: PreviewPort.of(3000),
        limits: PreviewLimits.of({
          memoryMiB: 1024,
          cpuPercent: 100,
          tasksMax: 512,
          buildMinutes: 20,
        }),
        now: minutes(requested),
      }),
    );
  }

  async function finish(id: string, outcome: 'succeeded' | 'failed', at: number, removed = false) {
    await operations.change(id, (op) => {
      op.claim(CONTROLLER, minutes(at - 1));
      if (outcome === 'succeeded') op.succeed(CONTROLLER, null, minutes(at));
      else {
        op.fail(CONTROLLER, PreviewOperationFailure.of('start_failed', 'no'), minutes(at), removed);
      }
    });
  }

  it('answers no settings, the hostname and a ready Repository for a new Project', async () => {
    await expect(handler.execute({ projectId: PROJECT })).resolves.toEqual({
      settings: null,
      hostname: 'preview-3f2b8c1e4d5a.preview.example.test',
      repository: { ready: true, commit: COMMIT },
      state: 'not_configured',
      running: null,
      latestBuild: null,
      latestChange: null,
      controller: { connected: false },
      behind: false,
      mergeRebuild: null,
    });
  });

  it('answers the settings that were saved, and a stopped Preview that was never built', async () => {
    await saveSettings();

    await expect(handler.execute({ projectId: PROJECT })).resolves.toMatchObject({
      settings: { composeFile: 'compose.yaml', service: 'web', port: 3000 },
      state: 'stopped',
    });
  });

  it('says why there is no hostname while no preview domain is configured', async () => {
    domain.domain = null;

    await expect(handler.execute({ projectId: PROJECT })).resolves.toMatchObject({
      hostname: null,
      hostnameUnavailable: 'not_configured',
    });
  });

  it.each(['no_repository', 'repository_not_ready', 'unsupported_platform'] as const)(
    'says the Repository is not ready, with %s',
    async (status) => {
      sources.statusAnswer = { status };

      await expect(handler.execute({ projectId: PROJECT })).resolves.toMatchObject({
        repository: { ready: false, reason: status },
      });
    },
  );

  it('names an unknown project', async () => {
    sources.statusAnswer = { status: 'project_not_found' };

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('says a queued build is building, and shows it', async () => {
    await saveSettings();
    await build(FIRST, -1);

    const view = await handler.execute({ projectId: PROJECT });

    expect(view.state).toBe('building');
    expect(view.latestBuild).toMatchObject({
      id: FIRST,
      status: 'queued',
      commit: 'b'.repeat(40),
      timeLimitMinutes: 20,
      startedAt: null,
      finishedAt: null,
      failure: null,
    });
  });

  it('says a succeeded build runs, with the commit, since and the link', async () => {
    await saveSettings();
    await build(FIRST, -10);
    await finish(FIRST, 'succeeded', -5);

    const view = await handler.execute({ projectId: PROJECT });

    expect(view.state).toBe('running');
    expect(view.running).toEqual({
      buildId: FIRST,
      commit: 'b'.repeat(40),
      since: minutes(-5),
      url: 'https://preview-3f2b8c1e4d5a.preview.example.test/',
    });
  });

  it('has no link while no preview domain is configured', async () => {
    domain.domain = null;
    await saveSettings();
    await build(FIRST, -10);
    await finish(FIRST, 'succeeded', -5);

    expect((await handler.execute({ projectId: PROJECT })).running?.url).toBeNull();
  });

  it('keeps running when a later build failed before it removed anything, and shows the failure', async () => {
    await saveSettings();
    await build(FIRST, -20);
    await finish(FIRST, 'succeeded', -15);
    await build(SECOND, -10);
    await finish(SECOND, 'failed', -5);

    const view = await handler.execute({ projectId: PROJECT });

    expect(view.state).toBe('running');
    expect(view.running?.buildId).toBe(FIRST);
    expect(view.latestBuild).toMatchObject({
      status: 'failed',
      failure: { code: 'start_failed', previewRemoved: false },
    });
  });

  it('is failed, with previewRemoved, when the failed build took the Preview down', async () => {
    await saveSettings();
    await build(FIRST, -20);
    await finish(FIRST, 'succeeded', -15);
    await build(SECOND, -10);
    await finish(SECOND, 'failed', -5, true);

    const view = await handler.execute({ projectId: PROJECT });

    expect(view.state).toBe('failed');
    expect(view.running).toBeNull();
    expect(view.latestBuild?.failure?.previewRemoved).toBe(true);
  });

  it('says whether a controller called within a lease', async () => {
    kit.presence.seen = minutes(0);
    expect((await handler.execute({ projectId: PROJECT })).controller).toEqual({
      connected: true,
    });

    kit.presence.seen = new Date(KIT_NOW.getTime() - 61_000);
    expect((await handler.execute({ projectId: PROJECT })).controller).toEqual({
      connected: false,
    });
  });

  describe('a stop or a data removal', () => {
    const CHANGE = '5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';

    async function change(kind: 'stop' | 'remove_data', requested: number) {
      await operations.add(
        PreviewOperation.requestOther({
          id: CHANGE,
          projectId: PROJECT,
          kind,
          now: minutes(requested),
        }),
      );
    }

    it('is stopping while a stop is requested, with the build that still runs', async () => {
      await saveSettings();
      await build(FIRST, -20);
      await finish(FIRST, 'succeeded', -15);
      await change('stop', -1);

      const view = await handler.execute({ projectId: PROJECT });

      expect(view.state).toBe('stopping');
      expect(view.running?.buildId).toBe(FIRST);
      expect(view.latestChange).toMatchObject({ kind: 'stop', status: 'queued', failure: null });
    });

    it('is resetting_data while a data removal is claimed', async () => {
      await saveSettings();
      await build(FIRST, -20);
      await finish(FIRST, 'succeeded', -15);
      await change('remove_data', -1);
      await operations.change(CHANGE, (op) => {
        op.claim(CONTROLLER, minutes(0));
      });

      const view = await handler.execute({ projectId: PROJECT });

      expect(view.state).toBe('resetting_data');
      expect(view.latestChange).toMatchObject({ kind: 'reset_data', status: 'in_progress' });
    });

    it('shows a failed stop as the latest change while the Preview runs on', async () => {
      await saveSettings();
      await build(FIRST, -20);
      await finish(FIRST, 'succeeded', -15);
      await change('stop', -10);
      await operations.change(CHANGE, (op) => {
        op.claim(CONTROLLER, minutes(-9));
        op.fail(
          CONTROLLER,
          PreviewOperationFailure.of('runtime_failed', 'Docker said no'),
          minutes(-8),
        );
      });

      const view = await handler.execute({ projectId: PROJECT });

      expect(view.state).toBe('running');
      expect(view.latestChange).toMatchObject({
        kind: 'stop',
        status: 'failed',
        failure: { code: 'runtime_failed', detail: 'Docker said no' },
      });
    });

    it('is stopped, not running, once the stop succeeded', async () => {
      await saveSettings();
      await build(FIRST, -20);
      await finish(FIRST, 'succeeded', -15);
      await change('stop', -10);
      await operations.change(CHANGE, (op) => {
        op.claim(CONTROLLER, minutes(-9));
        op.succeed(CONTROLLER, null, minutes(-8));
      });

      const view = await handler.execute({ projectId: PROJECT });

      expect(view.state).toBe('stopped');
      expect(view.running).toBeNull();
      expect(view.latestChange).toMatchObject({ kind: 'stop', status: 'succeeded' });
    });
  });

  it('stops showing the old build as running once a state check found nothing after a lost build', async () => {
    await saveSettings();
    await build(FIRST, -20);
    await finish(FIRST, 'succeeded', -15);
    await build(SECOND, -10);
    await operations.change(SECOND, (op) => {
      op.claim(CONTROLLER, minutes(-9));
      op.loseController(PreviewOperationFailure.of('controller_lost', 'silent'), minutes(-6));
    });
    expect((await handler.execute({ projectId: PROJECT })).state).toBe('running');

    const check = PreviewOperation.requestOther({
      id: '6c5b4a3d-2f1e-4b0c-9d8e-7f6a5b4c3d2e',
      projectId: PROJECT,
      kind: 'state',
      now: minutes(-5),
    });
    await operations.add(check);
    await operations.change(check.id, (op) => {
      op.claim(CONTROLLER, minutes(-4));
      op.succeed(CONTROLLER, PreviewOperationResult.of([]), minutes(-3));
    });

    const view = await handler.execute({ projectId: PROJECT });

    expect(view.state).toBe('failed');
    expect(view.running).toBeNull();
  });

  describe('behind and the rebuild after a merge', () => {
    const RUN = '3c1d8f2a-0b2f-4d6e-8a44-6b3c1d8f2a10';

    async function runningAt(commit: string) {
      await saveSettings();
      await operations.add(
        PreviewOperation.requestBuild({
          id: FIRST,
          projectId: PROJECT,
          commit: PreviewCommit.of(commit),
          composeFile: PreviewComposeFile.of('compose.yaml'),
          service: PreviewService.of('web'),
          port: PreviewPort.of(3000),
          limits: PreviewLimits.of({
            memoryMiB: 1024,
            cpuPercent: 100,
            tasksMax: 512,
            buildMinutes: 20,
          }),
          now: minutes(-10),
        }),
      );
      await finish(FIRST, 'succeeded', -5);
    }

    const recorded = (mergedCommit: string, fetchedAfter: boolean) =>
      kit.rebuilds.save(
        PreviewMergeRebuild.record({
          projectId: PROJECT,
          runId: RUN,
          mergedCommit,
          mergedAt: minutes(-2),
          fetchStartedAt: fetchedAfter ? minutes(-3) : minutes(3),
          now: minutes(-2),
        }),
      );

    it('is not behind while the running commit is the Clone commit', async () => {
      await runningAt(COMMIT);

      expect((await handler.execute({ projectId: PROJECT })).behind).toBe(false);
    });

    it('is behind when the Clone holds another commit than the one that runs', async () => {
      await runningAt('b'.repeat(40));

      expect((await handler.execute({ projectId: PROJECT })).behind).toBe(true);
    });

    it('is behind for a stopped Preview, against its latest build', async () => {
      await saveSettings();
      await build(FIRST, -10);
      await finish(FIRST, 'failed', -5);

      expect((await handler.execute({ projectId: PROJECT })).behind).toBe(true);
    });

    it('is not behind without a build, or while the Repository is not ready', async () => {
      await saveSettings();
      expect((await handler.execute({ projectId: PROJECT })).behind).toBe(false);

      await runningAt('b'.repeat(40));
      sources.statusAnswer = { status: 'repository_not_ready' };
      expect((await handler.execute({ projectId: PROJECT })).behind).toBe(false);
    });

    it('shows a waiting rebuild, and what it waits for', async () => {
      await runningAt('b'.repeat(40));
      sources.statusAnswer = { status: 'ready', commit: 'b'.repeat(40), fetchedAt: minutes(-9) };
      await recorded('e'.repeat(40), false);

      expect((await handler.execute({ projectId: PROJECT })).mergeRebuild).toEqual({
        runId: RUN,
        status: 'waiting',
        reason: 'the Clone fetch',
        since: minutes(-2),
      });
    });

    it('shows a failed rebuild with its reason', async () => {
      await runningAt('b'.repeat(40));
      await recorded('e'.repeat(40), false);
      const stored = await kit.rebuilds.find(PROJECT);
      stored!.fail('The Compose file was refused.', minutes(-1));
      await kit.rebuilds.saveFailure(stored!);

      expect((await handler.execute({ projectId: PROJECT })).mergeRebuild).toEqual({
        runId: RUN,
        status: 'failed',
        reason: 'The Compose file was refused.',
        since: minutes(-1),
      });
    });

    it('shows none when no merge asked for a rebuild', async () => {
      await runningAt('b'.repeat(40));

      expect((await handler.execute({ projectId: PROJECT })).mergeRebuild).toBeNull();
    });
  });
});
