import { describe, expect, it } from 'vitest';
import { DockerMissingError, DockerRunResources, type DockerExec } from '../run-resources.js';

// Issue #98: removing a Run's containers, networks and volumes, against a recording fake of
// the docker command (no Docker in unit tests).
const PROJECT = 'studio-run-0b8e5c2d1f3a';
const LABEL = `label=com.docker.compose.project=${PROJECT}`;

function recordingDocker(answers: Record<string, string | Error> = {}) {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push([...args]);
    const answer = answers[args.slice(0, 2).join(' ')];
    if (answer instanceof Error) throw answer;
    return answer ?? '';
  };
  return { exec, calls };
}

describe('DockerRunResources', () => {
  it('brings the Compose project down with its volumes, then removes what is left by label', async () => {
    const docker = recordingDocker({
      'ps -aq': 'c1\nc2\n',
      'network ls': 'n1\n',
      'volume ls': 'v1\n',
    });

    await new DockerRunResources(docker.exec).cleanUp(PROJECT);

    expect(docker.calls).toEqual([
      ['compose', '-p', PROJECT, 'down', '--volumes', '--remove-orphans'],
      ['ps', '-aq', '--filter', LABEL],
      ['rm', '--force', '--volumes', 'c1', 'c2'],
      ['network', 'ls', '-q', '--filter', LABEL],
      ['network', 'rm', 'n1'],
      ['volume', 'ls', '-q', '--filter', LABEL],
      ['volume', 'rm', '--force', 'v1'],
    ]);
  });

  it('removes nothing more when nothing is left', async () => {
    const docker = recordingDocker();

    await new DockerRunResources(docker.exec).cleanUp(PROJECT);

    expect(docker.calls.map((call) => call[0])).toEqual(['compose', 'ps', 'network', 'volume']);
  });

  it('still removes by label when compose down fails', async () => {
    const docker = recordingDocker({
      'compose -p': new Error('no such project'),
      'ps -aq': 'c1\n',
    });

    await new DockerRunResources(docker.exec).cleanUp(PROJECT);

    expect(docker.calls).toContainEqual(['rm', '--force', '--volumes', 'c1']);
  });

  it('fails when what is left cannot be removed, so the Working copy is kept', async () => {
    const docker = recordingDocker({ 'ps -aq': new Error('cannot connect to the daemon') });

    await expect(new DockerRunResources(docker.exec).cleanUp(PROJECT)).rejects.toThrow(
      'cannot connect',
    );
  });

  it('has nothing to remove without Docker', async () => {
    const docker = recordingDocker({ 'compose -p': new DockerMissingError() });

    await expect(new DockerRunResources(docker.exec).cleanUp(PROJECT)).resolves.toBeUndefined();
  });

  it("refuses a project name that is not a Run's", async () => {
    const docker = recordingDocker();

    await expect(new DockerRunResources(docker.exec).cleanUp('shop')).rejects.toThrow();
    await expect(new DockerRunResources(docker.exec).cleanUp(`${PROJECT} --all`)).rejects.toThrow();
    expect(docker.calls).toEqual([]);
  });
});
