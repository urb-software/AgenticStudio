import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { pinArgs } from '../system-git-adapter.js';

const NAME = 'git.example.test';

function listenOnIpv6Loopback(onRequest: (host: string | undefined) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      onRequest(request.headers.host);
      response.statusCode = 404;
      response.end();
    });
    server.once('error', reject);
    server.listen(0, '::1', () => resolve(server));
  });
}

// The pin is libcurl's CURLOPT_RESOLVE for http and https alike, so a plain HTTP server on
// `[::1]` shows that real Git reaches the pinned IPv6 address under the original Host name.
describe.runIf(process.platform === 'linux')('IPv6 pin against real git', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('connects to the pinned [::1] address with the original Host header', async (context) => {
    const hosts: Array<string | undefined> = [];
    try {
      server = await listenOnIpv6Loopback((host) => hosts.push(host));
    } catch {
      context.skip('this runner has no IPv6 loopback');
      return;
    }
    const { port } = server.address() as AddressInfo;
    const pin = pinArgs({
      transport: 'https',
      url: `https://${NAME}:${port}/owner/repo.git`,
      endpoint: { host: NAME, port },
      addresses: ['::1'],
    });
    expect(pin).toEqual(['-c', `http.curloptResolve=${NAME}:${port}:[::1]`]);

    // Asynchronous: the server lives in this process and must answer while Git waits.
    await new Promise<void>((resolve, reject) => {
      const git = spawn('git', [...pin, 'ls-remote', `http://${NAME}:${port}/owner/repo.git`], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: 'ignore',
        timeout: 20_000,
      });
      git.once('error', reject);
      git.once('close', () => resolve());
    });

    expect(hosts.length).toBeGreaterThan(0);
    expect(new Set(hosts)).toEqual(new Set([`${NAME}:${port}`]));
  });
});
