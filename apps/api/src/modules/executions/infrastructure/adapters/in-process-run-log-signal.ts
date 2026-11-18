import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { RunLogSignal } from '../../application/ports/run-log-signal.js';

/** Studio runs a single API instance; several would need a shared channel (e.g. Redis pub/sub) here. */
@Injectable()
export class InProcessRunLogSignal implements RunLogSignal {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  notify(runId: string): void {
    this.emitter.emit(runId);
  }

  subscribe(runId: string, listener: () => void): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }
}
