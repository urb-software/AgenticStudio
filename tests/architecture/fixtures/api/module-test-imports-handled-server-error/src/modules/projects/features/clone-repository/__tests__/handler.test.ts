import { HandledServerErrorException } from '../../../../../platform/http/handled-server-error.js';

// Forbidden: even a module test does not import the platform-only exception directly.
export const unavailable = new HandledServerErrorException();
