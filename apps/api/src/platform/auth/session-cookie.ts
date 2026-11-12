import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { HttpRequest, HttpResponse } from './http-types.js';

const BASE_NAME = 'studio_session';
const EXPIRED = 'Thu, 01 Jan 1970 00:00:00 GMT';

/**
 * The session cookie (security.md §8): `HttpOnly; SameSite=Lax; Path=/`, plus `Secure`
 * and the `__Host-` prefix when the Studio origin is https. No `Max-Age`: the browser
 * drops it at session end, and Redis enforces the inactivity TTL server-side.
 */
@Injectable()
export class SessionCookie {
  readonly name: string;
  private readonly attributes: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const secure = new URL(config.studioOrigin).protocol === 'https:';
    this.name = secure ? `__Host-${BASE_NAME}` : BASE_NAME;
    this.attributes = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  read(request: HttpRequest): string | undefined {
    for (const pair of (request.headers.cookie ?? '').split(';')) {
      const separator = pair.indexOf('=');
      if (separator > 0 && pair.slice(0, separator).trim() === this.name) {
        return pair.slice(separator + 1).trim();
      }
    }
    return undefined;
  }

  /** `sessionId` is base64url, so it needs no cookie encoding. */
  set(response: HttpResponse, sessionId: string): void {
    response.appendHeader('Set-Cookie', `${this.name}=${sessionId}; ${this.attributes}`);
  }

  clear(response: HttpResponse): void {
    response.appendHeader('Set-Cookie', `${this.name}=; ${this.attributes}; Expires=${EXPIRED}`);
  }
}
