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
 * Operator authentication: login/session/logout, plus two global guards that run in
 * this order on every route: the mutation Origin/content-type check, then the
 * deny-by-default session check.
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
  // Read-only, for long-lived responses that must notice a logout or expiry (the live Run log,
  // #99): never the session store itself (#104, from the #119 review).
  exports: [OperatorSessionCheck],
})
export class AuthModule {}
