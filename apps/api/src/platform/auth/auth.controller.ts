import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { LoginRequestDto, SessionResponseDto } from './auth.schema.js';
import { AuthService } from './auth.service.js';
import type { HttpRequest, HttpResponse } from './http-types.js';
import { Public } from './public.decorator.js';
import { SessionCookie } from './session-cookie.js';
import { NOT_AUTHENTICATED } from './session.guard.js';

const AUTHENTICATED = { authenticated: true as const };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookie: SessionCookie,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: 'login' })
  @ZodResponse({ status: 200, type: SessionResponseDto })
  async login(
    @Body() body: LoginRequestDto,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const result = await this.auth.login({
      password: body.password,
      clientIp: request.ip ?? 'unknown',
      previousSessionId: this.cookie.read(request),
    });
    switch (result.outcome) {
      case 'authenticated':
        this.cookie.set(response, result.sessionId);
        return AUTHENTICATED;
      case 'rate-limited':
        response.setHeader('Retry-After', String(result.retryAfterSeconds));
        throw new HttpException(
          'Too many failed login attempts. Try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'rejected':
        throw new UnauthorizedException(NOT_AUTHENTICATED);
    }
  }

  @Get('session')
  @ApiOperation({ operationId: 'getSession' })
  @ZodResponse({ status: 200, type: SessionResponseDto })
  session() {
    return AUTHENTICATED;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ operationId: 'logout' })
  @ApiNoContentResponse({ description: 'Session invalidated and cookie cleared' })
  async logout(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    await this.auth.logout(this.cookie.read(request));
    this.cookie.clear(response);
  }
}
