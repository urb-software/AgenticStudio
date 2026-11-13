import {
  Body,
  ConflictException,
  Controller,
  Get,
  type INestApplication,
  type LoggerService,
  Module,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testConfig, WITHOUT_QUEUE_WORKERS } from '../../../__tests__/test-config.js';
import { AppModule } from '../../../app.module.js';
import { Public } from '../../auth/public.decorator.js';
import { buildApp } from '../../../app.js';
import {
  FieldProblemException,
  ProblemException,
  problemDetailsSchema,
} from '../problem-details.js';

// Test-only endpoints: no production endpoint takes input yet (#12 DoR clarification 1).
// They are registered in this test's root module only, never in the production app.
// Public: this suite tests error mapping, not auth (covered in platform/auth).
const probeInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  tags: z.array(z.string().min(1)).optional(),
});
class ProbeInputDto extends createZodDto(probeInputSchema) {}

class ProbeOutputDto extends createZodDto(z.object({ id: z.string() })) {}

const LEAKY_MESSAGE =
  'connect ECONNREFUSED postgres://studio:s3cr3t@x@10.0.0.5 at C:\\srv\\internal\\db.ts';

@Public()
@Controller('__test__')
class ProbeController {
  @Post('echo')
  echo(@Body() body: ProbeInputDto) {
    return body;
  }

  @Get('crash')
  crash(): never {
    throw new Error(LEAKY_MESSAGE);
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException('A project with this name already exists.', {
      cause: new Error('unique constraint failed on nameNormalized'),
    });
  }

  @Get('field-conflict')
  fieldConflict(): never {
    throw new FieldProblemException(409, 'The request conflicts with existing data.', [
      { path: 'name', message: 'A project with this name already exists.' },
    ]);
  }

  @Get('unavailable')
  unavailable(): never {
    throw new ServiceUnavailableException('Redis at 10.0.0.7:6379 refused AUTH s3cr3t');
  }

  @Get('public-5xx')
  public5xx(): never {
    throw new ProblemException(501, {
      type: 'urn:agentic-studio:problem:probe',
      title: 'Probe unsupported',
      detail: 'This probe is not supported here.',
    });
  }

  @Get('typed-conflict')
  typedConflict(): never {
    throw new ProblemException(409, {
      type: 'urn:agentic-studio:problem:probe-conflict',
      title: 'Probe conflict',
      detail: 'The probe conflicts.',
      errors: [{ path: 'url', message: 'Already used.' }],
    });
  }

  @Get('bad-response')
  @ZodResponse({ status: 200, type: ProbeOutputDto })
  badResponse() {
    return { id: 42 } as unknown as { id: string };
  }
}

@Module({
  imports: [AppModule.register(testConfig(), WITHOUT_QUEUE_WORKERS)],
  controllers: [ProbeController],
})
class ProbeRootModule {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function expectProblem(response: request.Response, status: number, title: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(response.body).toMatchObject({
    type: 'about:blank',
    title,
    status,
    detail: expect.any(String),
    correlationId: expect.stringMatching(UUID),
  });
  // The runtime body must conform to the schema documented in OpenAPI.
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
}

/** Captures what the app logs, so tests can assert on the server-side record. */
class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  log() {}
  warn() {}
  debug() {}
  verbose() {}
  error(...parts: unknown[]) {
    this.lines.push(parts.map(String).join(' '));
  }
}

function expectNoInternals(response: request.Response) {
  const raw = response.text;
  for (const leak of [
    's3cr3t',
    'ECONNREFUSED',
    'C:\\\\srv',
    'internal',
    'stack',
    '.ts',
    'ZodError',
  ]) {
    expect(raw).not.toContain(leak);
  }
}

describe('problem+json error mapping', () => {
  let app: INestApplication;
  const logger = new CapturingLogger();

  beforeAll(async () => {
    app = await buildApp(ProbeRootModule, { logger });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('validates and transforms valid input through the Zod schema', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/__test__/echo')
      .set('Origin', 'http://localhost:3000')
      .send({ name: '  Alpha  ' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ name: 'Alpha' });
  });

  it('maps invalid input to 400 with field errors usable by React Hook Form', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/__test__/echo')
      .set('Origin', 'http://localhost:3000')
      .send({ name: '   ', tags: ['ok', ''] });

    expectProblem(response, 400, 'Bad Request');
    expect(response.body.errors).toEqual([
      { path: 'name', message: expect.any(String) },
      { path: 'tags.1', message: expect.any(String) },
    ]);
    expectNoInternals(response);
  });

  it('maps malformed JSON to 400 without parser internals', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/__test__/echo')
      .set('Origin', 'http://localhost:3000')
      .set('content-type', 'application/json')
      .send('{"name": ');

    expectProblem(response, 400, 'Bad Request');
    expect(response.body.detail).not.toMatch(/JSON|position|token/i);
  });

  it('maps an unknown route to 404', async () => {
    const response = await request(app.getHttpServer()).get('/api/does-not-exist');

    expectProblem(response, 404, 'Not Found');
    expect(response.body).not.toHaveProperty('errors');
    expectNoInternals(response);
  });

  it('keeps the message of a deliberate client error that carries a cause', async () => {
    const response = await request(app.getHttpServer()).get('/api/__test__/conflict');

    expectProblem(response, 409, 'Conflict');
    expect(response.body.detail).toBe('A project with this name already exists.');
    expect(response.text).not.toContain('nameNormalized');
  });

  it('keeps the field errors of a deliberate client error, for React Hook Form', async () => {
    const response = await request(app.getHttpServer()).get('/api/__test__/field-conflict');

    expectProblem(response, 409, 'Conflict');
    expect(response.body.detail).toBe('The request conflicts with existing data.');
    expect(response.body.errors).toEqual([
      { path: 'name', message: 'A project with this name already exists.' },
    ]);
  });

  it('maps an unexpected error to a generic 500 without leaking internals', async () => {
    const response = await request(app.getHttpServer()).get('/api/__test__/crash');

    expectProblem(response, 500, 'Internal Server Error');
    expect(response.body.detail).toBe('An unexpected error occurred.');
    expect(Object.keys(response.body).sort()).toEqual(
      ['correlationId', 'detail', 'status', 'title', 'type'].sort(),
    );
    expectNoInternals(response);

    // The cause is logged server-side under the same correlation id, with credentials redacted.
    const logged = logger.lines.find((line) => line.includes(response.body.correlationId));
    expect(logged).toContain('ECONNREFUSED postgres://***@10.0.0.5');
    expect(logged).not.toContain('s3cr3t');
  });

  it('keeps a deliberately thrown 5xx generic: no message or stack', async () => {
    const response = await request(app.getHttpServer()).get('/api/__test__/unavailable');

    expectProblem(response, 503, 'Service Unavailable');
    expect(response.body.detail).toBe('An unexpected error occurred.');
    expect(Object.keys(response.body).sort()).toEqual(
      ['correlationId', 'detail', 'status', 'title', 'type'].sort(),
    );
    expect(response.text).not.toMatch(/Redis|10\.0\.0\.7|AUTH|\bat \w/);
    expectNoInternals(response);
  });

  it('keeps the fixed text and type of a deliberate ProblemException 5xx, unlogged', async () => {
    const before = logger.lines.length;

    const response = await request(app.getHttpServer()).get('/api/__test__/public-5xx');

    expect(response.status).toBe(501);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toEqual({
      type: 'urn:agentic-studio:problem:probe',
      title: 'Probe unsupported',
      status: 501,
      detail: 'This probe is not supported here.',
      correlationId: expect.stringMatching(UUID),
    });
    expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
    expect(logger.lines.slice(before)).toEqual([]);
  });

  it('keeps the type, title and field errors of a deliberate ProblemException 4xx', async () => {
    const response = await request(app.getHttpServer()).get('/api/__test__/typed-conflict');

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      type: 'urn:agentic-studio:problem:probe-conflict',
      title: 'Probe conflict',
      detail: 'The probe conflicts.',
      errors: [{ path: 'url', message: 'Already used.' }],
    });
  });

  it('maps a response that violates its Zod schema to a generic 500', async () => {
    const response = await request(app.getHttpServer()).get('/api/__test__/bad-response');

    expectProblem(response, 500, 'Internal Server Error');
    expectNoInternals(response);
  });

  it('gives every error its own correlation id', async () => {
    const server = app.getHttpServer();
    const [first, second] = await Promise.all([
      request(server).get('/api/does-not-exist'),
      request(server).get('/api/does-not-exist'),
    ]);

    expect(first.body.correlationId).not.toBe(second.body.correlationId);
  });
});
