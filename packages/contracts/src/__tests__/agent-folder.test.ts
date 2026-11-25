import { describe, expect, it } from 'vitest';
import {
  AGENT_FOLDER_FILES_MAX,
  agentFolderQuerySchema,
  agentFolderResponseSchema,
  reportRunStateRequestSchema,
  RUN_FAILURE_CODES,
  WORKER_PROBLEM_TYPES,
} from '../index.js';

const COMMIT = 'a'.repeat(40);
const WORKER = '0b0f3a8e-3c1e-4d7a-8f5a-0c6c3f2d9a10';

describe('the agent folder hand-over', () => {
  const file = { path: 'scripts/run.sh', executable: true, contentBase64: 'IyEvYmluL3NoCg==' };

  it('answers a commit and files, or no commit and no files for a built-in agent', () => {
    expect(agentFolderResponseSchema.safeParse({ commit: COMMIT, files: [file] }).success).toBe(
      true,
    );
    expect(agentFolderResponseSchema.safeParse({ commit: null, files: [] }).success).toBe(true);
  });

  it('refuses a built-in answer with files, a folder without a commit id, and extra keys', () => {
    const parse = (value: unknown) => agentFolderResponseSchema.safeParse(value).success;
    expect(parse({ commit: null, files: [file] })).toBe(false);
    expect(parse({ commit: 'main', files: [] })).toBe(false);
    expect(parse({ commit: COMMIT, files: [{ ...file, mode: '0777' }] })).toBe(false);
    expect(parse({ commit: COMMIT, files: [{ ...file, contentBase64: 'not base64!' }] })).toBe(
      false,
    );
    expect(parse({ commit: COMMIT, files: [{ ...file, executable: 'yes' }] })).toBe(false);
  });

  it('bounds the number of files', () => {
    const many = Array.from({ length: AGENT_FOLDER_FILES_MAX + 1 }, (_, i) => ({
      ...file,
      path: `f${i}`,
    }));
    expect(agentFolderResponseSchema.safeParse({ commit: COMMIT, files: many }).success).toBe(
      false,
    );
  });

  it('is asked with the worker id only', () => {
    expect(agentFolderQuerySchema.safeParse({ workerId: WORKER }).success).toBe(true);
    expect(agentFolderQuerySchema.safeParse({ workerId: 'x' }).success).toBe(false);
    expect(agentFolderQuerySchema.safeParse({ workerId: WORKER, agent: 'other' }).success).toBe(
      false,
    );
    expect(agentFolderQuerySchema.safeParse({ workerId: WORKER, commit: COMMIT }).success).toBe(
      false,
    );
  });

  it('has two failure codes of its own, and the problem types the worker acts on', () => {
    expect(RUN_FAILURE_CODES).toContain('agent_folder_unavailable');
    expect(RUN_FAILURE_CODES).toContain('agent_folder_invalid');
    for (const code of ['agent_folder_unavailable', 'agent_folder_invalid']) {
      expect(
        reportRunStateRequestSchema.safeParse({
          workerId: WORKER,
          state: 'failed',
          failure: { code, detail: 'x' },
        }).success,
      ).toBe(true);
    }
    expect(WORKER_PROBLEM_TYPES.agentFolderUnavailable).toBe(
      'urn:agentic-studio:problem:agent-folder-unavailable',
    );
    expect(WORKER_PROBLEM_TYPES.agentFolderInvalid).toBe(
      'urn:agentic-studio:problem:agent-folder-invalid',
    );
  });
});
