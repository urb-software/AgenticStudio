import type { AgentFolderResponse, RunPayload } from '@agentic-studio/contracts';
import { WORKER_PROBLEM_TYPES } from '@agentic-studio/contracts';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentFolderInvalidError,
  AgentFolderUnavailableError,
  type AgentFolderApi,
  AgentFolders,
} from '../agent-folder.js';
import { StudioApiError } from '../studio-api.js';
import { agentFields } from './agent-fixtures.js';

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const COMMIT = 'c'.repeat(40);
const linux = process.platform === 'linux';

const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64');
const file = (path: string, content: string | Buffer, executable = false) => ({
  path,
  executable,
  contentBase64: b64(content),
});

const run = (commit: string | null = COMMIT): Pick<RunPayload, 'runId' | 'agent'> => ({
  runId: RUN_ID,
  agent:
    commit === null
      ? agentFields().agent
      : {
          name: 'reviewer',
          source: 'definitions',
          commit,
          provider: 'claude_code',
          model: 'default',
          instructions: 'Review.',
        },
});

const entries = (path: string): string[] => (existsSync(path) ? readdirSync(path) : []);

describe('AgentFolders', () => {
  let root: string;
  let dir: string;
  let answer: AgentFolderResponse | Error;
  let agentFolder: ReturnType<typeof vi.fn<AgentFolderApi['agentFolder']>>;
  let folders: AgentFolders;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-agent-folder-'));
    dir = join(root, 'agent');
    answer = { commit: COMMIT, files: [] };
    agentFolder = vi.fn<AgentFolderApi['agentFolder']>(() =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
    );
    folders = new AgentFolders({ api: { agentFolder } });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const place = (target = run()) => folders.place(target, dir, new AbortController().signal);

  it('writes the files below the folder, bytes unchanged, and answers where and how many', async () => {
    const png = Buffer.from([0x89, 0x50, 0xff, 0x00, 0xfe]);
    answer = {
      commit: COMMIT,
      files: [
        file('scripts/run.sh', '#!/bin/sh\necho hi\n', true),
        file('assets/logo.png', png),
        file('notes.txt', 'notes'),
      ],
    };

    await expect(place()).resolves.toEqual({ dir, files: 3 });

    expect((await readFile(join(dir, 'assets', 'logo.png'))).equals(png)).toBe(true);
    expect(await readFile(join(dir, 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(agentFolder).toHaveBeenCalledWith(RUN_ID, expect.any(AbortSignal));
  });

  it.skipIf(!linux)('gives files 0644, an executable one 0755, and directories 0755', async () => {
    answer = {
      commit: COMMIT,
      files: [file('scripts/run.sh', 'x', true), file('assets/a.txt', 'y'), file('top.txt', 'z')],
    };

    await place();

    const mode = async (path: string) => (await stat(join(dir, path))).mode & 0o777;
    expect(await mode('scripts/run.sh')).toBe(0o755);
    expect(await mode('assets/a.txt')).toBe(0o644);
    expect(await mode('top.txt')).toBe(0o644);
    expect(await mode('.')).toBe(0o755);
    expect(await mode('scripts')).toBe(0o755);
    expect(await mode('assets')).toBe(0o755);
  });

  it('deletes the folder and writes it fresh: what the agent left or added is gone', async () => {
    answer = { commit: COMMIT, files: [file('a.txt', 'one')] };
    await place();
    await writeFile(join(dir, 'a.txt'), 'changed by the agent');
    await mkdir(join(dir, 'planted'));
    await writeFile(join(dir, 'planted', 'extra.sh'), 'x');

    await place();

    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one');
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it.skipIf(!linux)('does not follow a link the agent planted when it rebuilds', async () => {
    answer = { commit: COMMIT, files: [file('a.txt', 'one')] };
    await place();
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'keep');
    await symlink(outside, join(dir, 'link'));
    await symlink(root, join(dir, 'dirlink'));

    await place();

    expect(await readFile(outside, 'utf8')).toBe('keep');
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it.skipIf(!linux)('replaces a link at the folder itself without following it', async () => {
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'keep.txt'), 'keep');
    await symlink(elsewhere, dir);
    answer = { commit: COMMIT, files: [file('a.txt', 'one')] };

    await place();

    expect((await lstat(dir)).isSymbolicLink()).toBe(false);
    expect(await readdir(elsewhere)).toEqual(['keep.txt']);
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('asks nothing and writes nothing for a built-in agent, and removes a stale folder', async () => {
    await mkdir(dir);
    await writeFile(join(dir, 'stale.txt'), 'x');

    await expect(place(run(null))).resolves.toBeNull();

    expect(agentFolder).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(false);
  });

  it('writes no folder for an agent that has no files, and removes a stale one', async () => {
    await mkdir(dir);
    answer = { commit: COMMIT, files: [] };

    await expect(place()).resolves.toBeNull();

    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ['a path that leaves the folder', [file('../escape.sh', 'x')]],
    ['an absolute path', [file('/etc/cron.d/x', 'x')]],
    ['a hidden path', [file('.claude/settings.json', '{}')]],
    ['a CLI instruction file', [file('docs/CLAUDE.md', 'x')]],
    ['a skill file', [file('skills/x/SKILL.md', 'x')]],
    ['a path inside a Git directory', [file('a/.git/config', 'x')]],
    ['the entry file itself', [file('AGENT.md', '---\nname: x\n---\n')]],
    ['two paths that differ in case', [file('A.txt', 'a'), file('a.txt', 'b')]],
    ['a file over the size limit', [file('big.bin', Buffer.alloc(1024 * 1024 + 1))]],
  ])('refuses %s and writes nothing', async (_what, files) => {
    answer = { commit: COMMIT, files };

    await expect(place()).rejects.toThrow(AgentFolderInvalidError);

    expect(existsSync(dir)).toBe(false);
    expect(entries(root)).toEqual([]);
  });

  it('refuses content that is not canonical base64', async () => {
    answer = {
      commit: COMMIT,
      files: [{ path: 'a.txt', executable: false, contentBase64: 'QR==' }],
    };

    await expect(place()).rejects.toThrow(AgentFolderInvalidError);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a hand-over that names another commit than the Run recorded', async () => {
    answer = { commit: 'd'.repeat(40), files: [file('a.txt', 'x')] };

    await expect(place()).rejects.toThrow(AgentFolderInvalidError);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps an earlier folder when the new hand-over is refused', async () => {
    answer = { commit: COMMIT, files: [file('a.txt', 'one')] };
    await place();
    answer = { commit: COMMIT, files: [file('../x', 'two')] };

    await expect(place()).rejects.toThrow(AgentFolderInvalidError);
  });

  it('turns the API refusals into the errors the Run fails with', async () => {
    answer = new StudioApiError(
      409,
      '/api/worker/runs/x/agent-folder',
      WORKER_PROBLEM_TYPES.agentFolderUnavailable,
    );
    await expect(place()).rejects.toThrow(AgentFolderUnavailableError);

    answer = new StudioApiError(
      409,
      '/api/worker/runs/x/agent-folder',
      WORKER_PROBLEM_TYPES.agentFolderInvalid,
    );
    await expect(place()).rejects.toThrow(AgentFolderInvalidError);

    const other = new StudioApiError(404, '/api/worker/runs/x/agent-folder');
    answer = other;
    await expect(place()).rejects.toBe(other);
    const network = new TypeError('fetch failed');
    answer = network;
    await expect(place()).rejects.toBe(network);
  });

  it('starts no process and never runs a file it wrote: a script stays unrun', async () => {
    const marker = join(root, 'ran');
    answer = {
      commit: COMMIT,
      files: [file('run.sh', `#!/bin/sh\ntouch '${marker}'\n`, true), file('run.py', 'x', true)],
    };

    await place();

    expect(existsSync(marker)).toBe(false);
  });

  describe('the blob ids of the files, for the push check', () => {
    const gitBlob = (algorithm: 'sha1' | 'sha256', content: Buffer) =>
      createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex');

    it('lists the SHA-1 and SHA-256 blob ids of every non-empty file, with its path', async () => {
      const script = Buffer.from('#!/bin/sh\necho hi\n');
      answer = {
        commit: COMMIT,
        files: [file('scripts/run.sh', script, true), file('empty', '')],
      };

      const blobs = await folders.placedBlobs(run(), new AbortController().signal);

      expect(blobs.get(gitBlob('sha1', script))).toBe('scripts/run.sh');
      expect(blobs.get(gitBlob('sha256', script))).toBe('scripts/run.sh');
      expect(blobs.get(gitBlob('sha1', Buffer.alloc(0)))).toBeUndefined();
      expect(blobs.size).toBe(2);
      expect(existsSync(dir)).toBe(false);
    });

    it('is empty for a built-in agent, without asking', async () => {
      const blobs = await folders.placedBlobs(run(null), new AbortController().signal);

      expect(blobs.size).toBe(0);
      expect(agentFolder).not.toHaveBeenCalled();
    });

    it('fails when the hand-over is refused, so nothing is pushed unchecked', async () => {
      answer = { commit: COMMIT, files: [file('../x', 'y')] };

      await expect(folders.placedBlobs(run(), new AbortController().signal)).rejects.toThrow(
        AgentFolderInvalidError,
      );
    });
  });
});
