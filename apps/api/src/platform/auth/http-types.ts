import type { IncomingMessage, ServerResponse } from 'node:http';

/** The Express request as auth uses it; `ip` honours the `trust proxy` setting (app.ts). */
export type HttpRequest = IncomingMessage & { ip?: string };

export type HttpResponse = ServerResponse;
