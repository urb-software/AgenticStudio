import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import type { RunLogSignal } from '../../application/ports/run-log-signal.js';

/**
 * In-process {@link RunLogSignal} (Issue #99): one event per Run id. Studio runs a single API
 * instance; several instances would need a shared channel (e.g. Redis pub/sub) here, and
 * nothing else would change.
 */
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
