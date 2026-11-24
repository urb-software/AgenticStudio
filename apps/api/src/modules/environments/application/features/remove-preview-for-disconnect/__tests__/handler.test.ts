import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import { PreviewOperationFailure } from '../../../../domain/value-objects/preview-operation-failure.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import {
  KIT_CONTROLLER,
  KIT_NOW as NOW,
  savePreviewSettings,
  seedBuild,
} from '../../../__tests__/preview-test-kit.js';
import { RemovePreviewForDisconnectHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const BUILD = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const REMOVAL = '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21';
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe('RemovePreviewForDisconnectHandler', () => {
  let operations: InMemoryPreviewOperationRepository;
  let settings: InMemoryPreviewSettingsRepository;
  let handler: RemovePreviewForDisconnectHandler;

  beforeEach(() => {
    operations = new InMemoryPreviewOperationRepository();
    settings = new InMemoryPreviewSettingsRepository();
    handler = new RemovePreviewForDisconnectHandler(settings, operations, { now: () => later(10) });
  });

  const run = (projectId = PROJECT) => handler.execute({ projectId });
  const removals = () =>
    [...operations.operations.values()].filter((operation) => operation.kind === 'remove_data');

  async function removal(status: 'requested' | 'claimed' | 'succeeded' | 'failed', minutes = 5) {
    await operations.add(
      PreviewOperation.requestOther({
        id: REMOVAL,
        projectId: PROJECT,
        kind: 'remove_data',
        now: later(minutes),
      }),
    );
    if (status === 'requested') return;
    await operations.change(REMOVAL, (op) => {
      op.claim(KIT_CONTROLLER, later(minutes));
      if (status === 'succeeded') op.succeed(KIT_CONTROLLER, null, later(minutes + 1));
      if (status === 'failed') {
        op.loseController(PreviewOperationFailure.of('controller_lost', 'x'), later(minutes + 1));
      }
    });
  }

  it('step 1: deletes the settings when the Project has no operation', async () => {
    await savePreviewSettings(settings, PROJECT);
    await savePreviewSettings(settings, OTHER);

    await expect(run()).resolves.toBe('done');

    expect(await settings.find(PROJECT)).toBeNull();
    expect(await settings.find(OTHER)).not.toBeNull();
  });

  it('step 2: deletes the settings and the operations when no build was ever claimed', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, BUILD, 'requested');
    await seedBuild(operations, OTHER, '2d4b8f74-5f2d-4f80-8c66-8d5e3f0b4c32', 'requested');

    await expect(run()).resolves.toBe('done');

    expect(await settings.find(PROJECT)).toBeNull();
    expect(await operations.find(BUILD)).toBeNull();
    expect(await operations.find('2d4b8f74-5f2d-4f80-8c66-8d5e3f0b4c32')).not.toBeNull();
  });

  it('step 3: deletes everything once the data removal succeeded and nothing is active', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');
    await removal('succeeded');

    await expect(run()).resolves.toBe('done');

    expect(await settings.find(PROJECT)).toBeNull();
    expect(operations.operations.size).toBe(0);
  });

  it('step 4: requests a data removal for what ran, and is pending', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');

    await expect(run()).resolves.toBe('pending');

    expect(removals()).toHaveLength(1);
    expect(removals()[0]).toMatchObject({ status: 'requested', requestedAt: later(10) });
    expect(await settings.find(PROJECT)).not.toBeNull();
  });

  it('step 4: waits for a removal that is requested or claimed, and adds none', async () => {
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');
    await removal('claimed');

    await expect(run()).resolves.toBe('pending');
    await expect(run()).resolves.toBe('pending');

    expect(removals()).toHaveLength(1);
  });

  it('step 4: asks again after a removal that failed, as it does after one nobody claimed', async () => {
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');
    await removal('failed');

    await expect(run()).resolves.toBe('pending');

    expect(removals()).toHaveLength(2);
  });

  it('runs again until it is done: request, wait, finish', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');

    await expect(run()).resolves.toBe('pending');
    const [requested] = removals();
    await operations.change(requested!.id, (op) => {
      op.claim(KIT_CONTROLLER, later(11));
    });
    await expect(run()).resolves.toBe('pending');
    await operations.change(requested!.id, (op) => {
      op.succeed(KIT_CONTROLLER, null, later(12));
    });

    await expect(run()).resolves.toBe('done');
    expect(operations.operations.size).toBe(0);
    expect(await settings.find(PROJECT)).toBeNull();
  });

  it('treats a removal requested meanwhile as the one to wait for', async () => {
    const failing = new InMemoryPreviewOperationRepository();
    await seedBuild(failing, PROJECT, BUILD, 'succeeded');
    const racing = new RemovePreviewForDisconnectHandler(settings, failing, {
      now: () => later(10),
    });
    const facts = failing.findDisconnectFacts.bind(failing);
    failing.findDisconnectFacts = async (projectId) => {
      const read = await facts(projectId);
      await failing.add(
        PreviewOperation.requestOther({
          id: REMOVAL,
          projectId,
          kind: 'remove_data',
          now: later(9),
        }),
      );
      return read;
    };

    await expect(racing.execute({ projectId: PROJECT })).resolves.toBe('pending');
  });

  it('keeps everything and is pending when a build was claimed after the facts were read', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, BUILD, 'requested');
    const facts = operations.findDisconnectFacts.bind(operations);
    let first = true;
    operations.findDisconnectFacts = async (projectId) => {
      const read = await facts(projectId);
      if (first) {
        first = false;
        await operations.change(BUILD, (op) => {
          op.claim(KIT_CONTROLLER, later(9));
        });
      }
      return read;
    };

    await expect(run()).resolves.toBe('pending');

    expect(await operations.find(BUILD)).toMatchObject({ status: 'claimed' });
    expect(await settings.find(PROJECT)).not.toBeNull();
  });
});
