import { healthModule } from '../../../../../platform/health/health.module.js';

// Allowed: a module test may boot the whole app, which reaches the platform's health wiring.
export const app = { modules: [healthModule] };
