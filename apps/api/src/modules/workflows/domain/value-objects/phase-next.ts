import type { NextStep } from './next-step.js';

/** What follows a Phase's result: also a send-back to the work Phase at `position`. */
export type PhaseNext = NextStep | { kind: 'send_back'; position: number };
