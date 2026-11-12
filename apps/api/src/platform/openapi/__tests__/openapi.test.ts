import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import { createOpenApiDocument } from '../openapi.js';

describe('OpenAPI document', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Offline: the database client connects lazily and the app never listens.
    app = await createApp({
      apiPort: 0,
      apiOrigin: 'http://localhost:3001',
      databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/unused',
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('is OpenAPI 3.1', () => {
    expect(createOpenApiDocument(app).openapi).toBe('3.1.0');
  });

  it('documents GET /api/health with its Zod-derived response schema (nestjs-zod suffixes response schemas with _Output)', () => {
    const document = createOpenApiDocument(app);

    const operation = document.paths['/api/health']?.get;
    expect(operation?.operationId).toBe('getHealth');
    expect(operation?.responses['200']).toMatchObject({
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/HealthResponse_Output' } },
      },
    });
    expect(document.components?.schemas?.HealthResponse_Output).toEqual({
      type: 'object',
      properties: { status: { type: 'string', const: 'ok' } },
      required: ['status'],
      additionalProperties: false,
    });
  });

  it('documents the problem+json schema as the error response of every operation', () => {
    const document = createOpenApiDocument(app);

    expect(document.paths['/api/health']?.get?.responses.default).toMatchObject({
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
      },
    });
    expect(document.components?.schemas?.ProblemDetails).toMatchObject({
      type: 'object',
      properties: {
        type: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'integer' },
        detail: { type: 'string' },
        correlationId: { type: 'string' },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, message: { type: 'string' } },
            required: ['path', 'message'],
          },
        },
      },
      required: ['type', 'title', 'status', 'detail', 'correlationId'],
    });
  });

  it('is deterministic', () => {
    expect(JSON.stringify(createOpenApiDocument(app))).toBe(
      JSON.stringify(createOpenApiDocument(app)),
    );
  });
});
