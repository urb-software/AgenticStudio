import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRedis, type TestService } from '../index.js';

// Sends one inline Redis command over a raw socket and returns the first reply line.
function sendInlineCommand(url: string, command: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) }, () => {
      socket.write(`${command}\r\n`);
    });
    socket.setEncoding('utf8');
    socket.once('data', (reply: string) => {
      socket.end();
      resolve(reply.trim());
    });
    socket.once('error', reject);
  });
}

describe('startRedis', () => {
  let redis: TestService;

  beforeAll(async () => {
    redis = await startRedis();
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it('provides a reachable, throwaway Redis server', async () => {
    expect(redis.url).toMatch(/^redis:\/\//);
    await expect(sendInlineCommand(redis.url, 'PING')).resolves.toBe('+PONG');
  });
});
