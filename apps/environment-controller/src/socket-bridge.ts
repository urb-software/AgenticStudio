import { chmod, chown, lstat, readFile, rm, stat } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OperationFailure } from './failure.js';
import type { ProcessRunner, RunningProcess } from './process-runner.js';

export interface BridgeSpec {
  /** `preview-<12 hex>`: the socket is `<dir>/<previewLabel>.sock`. */
  previewLabel: string;
  /** The entry container's address on its network, and the port of the entry service. */
  address: string;
  port: number;
  containerId: string;
}

/** One socket per running Preview, from the proxy to the entry service. */
export interface SocketBridges {
  create(spec: BridgeSpec): Promise<void>;
  /** Stops the bridge and removes its socket; nothing happens when there is none. */
  remove(previewLabel: string): Promise<void>;
  /** Stops every bridge (the controller shuts down). */
  closeAll(): Promise<void>;
}

const SOCKET_WAIT_MS = 5000;

const failed = (detail: string) => new OperationFailure('runtime_failed', detail);

/**
 * Removes a stale socket before listening, but only a socket that is ours: the directory holds
 * nothing else, and a file of another kind or owner is never touched.
 */
export async function removeStaleSocket(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing === null) return;
  if (!existing.isSocket())
    throw failed('The proxy socket path holds something that is not a socket.');
  const uid = process.getuid?.();
  if (uid !== undefined && existing.uid !== uid) {
    throw failed('The proxy socket path holds a socket of another user.');
  }
  await rm(path, { force: true });
}

async function requireDirectory(dir: string): Promise<void> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw failed('The proxy socket directory is missing.');
}

async function waitForSocket(path: string, alive: () => boolean): Promise<void> {
  const deadline = Date.now() + SOCKET_WAIT_MS;
  while (Date.now() < deadline) {
    if (!alive()) throw failed('The socket bridge process ended before it listened.');
    if ((await lstat(path).catch(() => null))?.isSocket()) return;
    await delay(25);
  }
  throw failed('The socket bridge did not start listening in time.');
}

/**
 * The rootless bridge: `socat` listens on the socket and connects to the entry container, run
 * inside the rootless daemon's network namespace through `nsenter` as the Preview user. The
 * group of the socket is set to the proxy group as soon as it appears.
 */
export class NsenterSocatBridges implements SocketBridges {
  private readonly running = new Map<string, RunningProcess>();

  constructor(
    private readonly options: {
      runner: ProcessRunner;
      dir: string;
      proxyGid: number;
      /** The file in which the rootless daemon records its network namespace holder's pid. */
      childPidFile: string;
      env: Record<string, string>;
      killGraceMs?: number;
    },
  ) {}

  socketPath(previewLabel: string): string {
    return join(this.options.dir, `${previewLabel}.sock`);
  }

  async create(spec: BridgeSpec): Promise<void> {
    await this.remove(spec.previewLabel);
    await requireDirectory(this.options.dir);
    const socket = this.socketPath(spec.previewLabel);
    await removeStaleSocket(socket);
    const pid = Number((await readFile(this.options.childPidFile, 'utf8').catch(() => '')).trim());
    if (!Number.isInteger(pid) || pid < 2)
      throw failed('The rootless daemon namespace is unknown.');
    const bridge = this.options.runner.start({
      binary: 'nsenter',
      args: [
        '-U',
        '--preserve-credentials',
        '-n',
        '-t',
        String(pid),
        'socat',
        `UNIX-LISTEN:${socket},fork,mode=0660`,
        `TCP:${spec.address}:${spec.port}`,
      ],
      env: this.options.env,
      graceMs: this.options.killGraceMs,
    });
    let ended = false;
    void bridge.exited.then(() => {
      ended = true;
      if (this.running.get(spec.previewLabel) === bridge) this.running.delete(spec.previewLabel);
    });
    this.running.set(spec.previewLabel, bridge);
    try {
      await waitForSocket(socket, () => !ended);
      await chown(socket, -1, this.options.proxyGid);
    } catch (error) {
      await this.remove(spec.previewLabel);
      throw error instanceof OperationFailure
        ? error
        : failed('The proxy socket could not be set up.');
    }
  }

  async remove(previewLabel: string): Promise<void> {
    const bridge = this.running.get(previewLabel);
    this.running.delete(previewLabel);
    await bridge?.stop();
    await removeStaleSocket(this.socketPath(previewLabel)).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((label) => this.remove(label)));
  }
}

/**
 * The bridge for tests and development on a system Docker, where the entry container's address
 * is reachable from the host: a Node.js proxy from the socket to the address, no namespace.
 */
export class NodeProxyBridges implements SocketBridges {
  private readonly servers = new Map<string, { server: Server; sockets: Set<Socket> }>();

  constructor(private readonly options: { dir: string; proxyGid: number }) {}

  socketPath(previewLabel: string): string {
    return join(this.options.dir, `${previewLabel}.sock`);
  }

  async create(spec: BridgeSpec): Promise<void> {
    await this.remove(spec.previewLabel);
    await requireDirectory(this.options.dir);
    const path = this.socketPath(spec.previewLabel);
    await removeStaleSocket(path);
    const sockets = new Set<Socket>();
    const server = createServer((client) => {
      const upstream = createConnection({ host: spec.address, port: spec.port });
      sockets.add(client).add(upstream);
      client.pipe(upstream).pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on('error', close).on('close', close);
      upstream.on('error', close).on('close', close);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    }).catch(() => {
      throw failed('The proxy socket could not be created.');
    });
    this.servers.set(spec.previewLabel, { server, sockets });
    await chmod(path, 0o660);
    await chown(path, -1, this.options.proxyGid).catch(() => undefined);
  }

  async remove(previewLabel: string): Promise<void> {
    const entry = this.servers.get(previewLabel);
    this.servers.delete(previewLabel);
    if (entry) {
      for (const socket of entry.sockets) socket.destroy();
      await new Promise<void>((resolve) => entry.server.close(() => resolve()));
    }
    await removeStaleSocket(this.socketPath(previewLabel)).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((label) => this.remove(label)));
  }
}

/** Records what would be bridged; for the fake runtime. */
export class RecordingBridges implements SocketBridges {
  readonly events: { event: 'create' | 'remove'; previewLabel: string }[] = [];
  private readonly active = new Set<string>();

  async create(spec: BridgeSpec): Promise<void> {
    this.active.add(spec.previewLabel);
    this.events.push({ event: 'create', previewLabel: spec.previewLabel });
  }

  async remove(previewLabel: string): Promise<void> {
    if (!this.active.delete(previewLabel)) return;
    this.events.push({ event: 'remove', previewLabel });
  }

  async closeAll(): Promise<void> {
    for (const label of [...this.active]) await this.remove(label);
  }

  get open(): string[] {
    return [...this.active];
  }
}
