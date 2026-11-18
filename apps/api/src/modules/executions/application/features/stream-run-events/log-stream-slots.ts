import { Inject, Injectable } from '@nestjs/common';
import { RUN_LOG_SETTINGS, type RunLogSettings } from '../../ports/run-log-settings.js';

/** In process, as the streams are: one API instance. */
@Injectable()
export class LogStreamSlots {
  private readonly perSession = new Map<string, number>();
  private total = 0;

  constructor(@Inject(RUN_LOG_SETTINGS) private readonly settings: RunLogSettings) {}

  /** Takes a slot for `session`; returns its release (call it once), or `null` when full. */
  acquire(session: string): (() => void) | null {
    const held = this.perSession.get(session) ?? 0;
    if (held >= this.settings.streamsPerSession || this.total >= this.settings.streamsTotal) {
      return null;
    }
    this.perSession.set(session, held + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.perSession.get(session) ?? 1) - 1;
      if (left > 0) this.perSession.set(session, left);
      else this.perSession.delete(session);
    };
  }
}
