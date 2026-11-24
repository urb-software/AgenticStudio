import { describe, expect, it } from 'vitest';
import { NodeProcessRunner } from '../process-runner.js';

// Every literal binary is mapped to this Node.js, so the tests run real processes.
const node = process.execPath;
const runner = new NodeProcessRunner({
  docker: node,
  systemctl: node,
  'egress-rules': node,
  nsenter: node,
});
const env = { PATH: process.env.PATH ?? '' };
const script = (code: string) => ['-e', code];

describe('NodeProcessRunner', () => {
  it('runs an argument array without a shell and returns the output', async () => {
    const result = await runner.run({
      binary: 'docker',
      args: script('console.log(process.argv.slice(1).join("|"))').concat(['a b', ';', '$HOME']),
      env,
      timeoutMs: 20_000,
    });
    expect(result).toMatchObject({ exitCode: 0, interrupted: null });
    expect(result.stdout.trim()).toBe('a b|;|$HOME');
  });

  it('gives the process exactly the environment it is passed', async () => {
    const result = await runner.run({
      binary: 'docker',
      args: script('console.log(Object.keys(process.env).sort().join(","))'),
      env: { ...env, ONLY: 'this' },
      timeoutMs: 20_000,
    });
    const names = result.stdout.trim().split(',');
    expect(names).toContain('ONLY');
    expect(names).not.toContain('HOME_SECRET');
    expect(process.env.STUDIO_CONTROLLER_TOKEN).toBeUndefined();
  });

  it('delivers output lines as they complete, stdout and stderr apart', async () => {
    const lines: string[] = [];
    await runner.run({
      binary: 'docker',
      args: script(
        'process.stdout.write("one\\ntw"); process.stderr.write("err\\n"); process.stdout.write("o\\nlast")',
      ),
      env,
      timeoutMs: 20_000,
      onLine: (stream, line) => lines.push(`${stream}:${line}`),
    });
    expect(lines.filter((line) => line.startsWith('stdout'))).toEqual([
      'stdout:one',
      'stdout:two',
      'stdout:last',
    ]);
    expect(lines).toContain('stderr:err');
  });

  it('reports a non-zero exit code and the end of standard error', async () => {
    const result = await runner.run({
      binary: 'systemctl',
      args: script('console.error("boom"); process.exit(3)'),
      env,
      timeoutMs: 20_000,
    });
    expect(result).toMatchObject({ exitCode: 3, interrupted: null });
    expect(result.stderr).toContain('boom');
  });

  it('kills a process at its timeout', async () => {
    const started = Date.now();
    const result = await runner.run({
      binary: 'docker',
      args: script('setInterval(() => {}, 1000)'),
      env,
      timeoutMs: 300,
      graceMs: 200,
    });
    expect(result).toMatchObject({ exitCode: null, interrupted: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('kills a process when the signal aborts, and not at all when it is aborted already', async () => {
    const controller = new AbortController();
    const pending = runner.run({
      binary: 'docker',
      args: script('setInterval(() => {}, 1000)'),
      env,
      timeoutMs: 60_000,
      graceMs: 200,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toMatchObject({ interrupted: 'aborted', exitCode: null });
    expect(
      await runner.run({
        binary: 'docker',
        args: script('console.log(1)'),
        env,
        timeoutMs: 1000,
        signal: AbortSignal.abort(),
      }),
    ).toMatchObject({ interrupted: 'aborted', stdout: '' });
  });

  it.skipIf(process.platform === 'win32')(
    'sends SIGKILL after the grace period to a process that ignores SIGTERM, and to its children',
    async () => {
      const result = await runner.run({
        binary: 'docker',
        args: script(
          'process.on("SIGTERM", () => {}); require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); setInterval(() => {}, 1000)',
        ),
        env,
        timeoutMs: 300,
        graceMs: 300,
      });
      expect(result.interrupted).toBe('timeout');
    },
  );

  it('reports a missing program', async () => {
    const missing = new NodeProcessRunner({
      docker: '/definitely/not/here',
      systemctl: node,
      'egress-rules': node,
      nsenter: node,
    });
    expect(await missing.run({ binary: 'docker', args: [], env, timeoutMs: 1000 })).toMatchObject({
      exitCode: null,
      interrupted: 'missing',
    });
  });

  it('starts a long-running process and stops it', async () => {
    const running = runner.start({
      binary: 'nsenter',
      args: script('setInterval(() => {}, 1000)'),
      env,
      graceMs: 200,
    });
    expect(running.pid).toBeGreaterThan(0);
    await running.stop();
    expect((await running.exited).interrupted).toBeNull();
  });
});
