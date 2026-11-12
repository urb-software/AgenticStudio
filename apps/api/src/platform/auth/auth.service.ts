import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { verifyPassword } from './password.js';
import { SessionStore } from './session-store.js';

export type LoginResult =
  | { outcome: 'authenticated'; sessionId: string }
  | { outcome: 'rejected' }
  | { outcome: 'rate-limited'; retryAfterSeconds: number };

/** Single-operator login and logout (security.md §8). Logs never carry secrets. */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly limiter: LoginRateLimiter,
    private readonly sessions: SessionStore,
  ) {}

  async login(input: {
    password: string;
    clientIp: string;
    previousSessionId: string | undefined;
  }): Promise<LoginResult> {
    const attempt = await this.limiter.reserve(input.clientIp);
    if (!attempt.allowed) {
      this.logger.warn(`Login rate limit reached [ip=${input.clientIp}]`);
      return { outcome: 'rate-limited', retryAfterSeconds: attempt.retryAfterSeconds };
    }
    if (!(await verifyPassword(this.config.operatorPasswordHash, input.password))) {
      this.logger.warn(`Login failed [ip=${input.clientIp}]`);
      return { outcome: 'rejected' };
    }
    await this.limiter.succeeded(input.clientIp);
    // Rotate: a session presented at login never survives it.
    if (input.previousSessionId) {
      await this.sessions.delete(input.previousSessionId);
    }
    const sessionId = await this.sessions.create();
    this.logger.log(`Login succeeded [ip=${input.clientIp}]`);
    return { outcome: 'authenticated', sessionId };
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId) {
      await this.sessions.delete(sessionId);
    }
  }
}
