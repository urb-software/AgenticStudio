import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { MutationOriginGuard } from './mutation-origin.guard.js';
import { OperatorSessionCheck } from './operator-session-check.js';
import { redisClientProvider, RedisShutdown } from './redis.js';
import { SessionCookie } from './session-cookie.js';
import { SessionStore } from './session-store.js';
import { SessionGuard } from './session.guard.js';

/**
 * Operator login/session/logout, plus the global guards, which run in this order: the
 * mutation-origin check, then the deny-by-default session check.
 */
@Module({
  controllers: [AuthController],
  providers: [
    redisClientProvider,
    RedisShutdown,
    SessionStore,
    LoginRateLimiter,
    SessionCookie,
    AuthService,
    OperatorSessionCheck,
    { provide: APP_GUARD, useClass: MutationOriginGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  // Read-only, so a long-lived response can notice logout or expiry; never the session store.
  exports: [OperatorSessionCheck],
})
export class AuthModule {}
