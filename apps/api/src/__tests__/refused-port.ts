import { createServer, type Server } from 'node:net';

/**
 * A loopback port that stays taken and resets every connection at once. A port that was only
 * bound and closed can be taken by a parallel worker's silent server, and `ssh-keyscan` then
 * times out instead of `host_unreachable`.
 */
export interface RefusedPorts {
  /** Reserves a new port; it stays refusing until `release()`. */
  reserve(): Promise<number>;
  /** Stops every server this helper started (call it in `afterAll`). */
  release(): Promise<void>;
}

export function refusedPorts(): RefusedPorts {
  const servers: Server[] = [];
  return {
    async reserve() {
      const server = createServer((socket) => {
        // A reset where available, else a plain close: either is "closed by remote host".
        if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
        else socket.destroy();
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      servers.push(server);
      return (server.address() as { port: number }).port;
    },
    async release() {
      await Promise.all(
        servers
          .splice(0)
          .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    },
  };
}
