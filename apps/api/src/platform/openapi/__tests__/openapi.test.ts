import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../../../__tests__/test-config.js';
import { createApp } from '../../../app.js';
import { createOpenApiDocument } from '../openapi.js';

describe('OpenAPI document', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Offline: the database client connects lazily and the app never listens.
    app = await createApp(testConfig());
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

  it('documents the auth endpoints with their Zod-derived schemas', () => {
    const document = createOpenApiDocument(app);

    const login = document.paths['/api/auth/login']?.post;
    expect(login?.operationId).toBe('login');
    expect(login?.requestBody).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
    });
    expect(document.components?.schemas?.LoginRequest).toMatchObject({
      type: 'object',
      properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } },
      required: ['password'],
    });
    expect(login?.responses['200']).toMatchObject({
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/SessionResponse_Output' } },
      },
    });
    expect(document.components?.schemas?.SessionResponse_Output).toMatchObject({
      properties: { authenticated: { type: 'boolean', const: true } },
      required: ['authenticated'],
    });

    expect(document.paths['/api/auth/session']?.get?.operationId).toBe('getSession');
    const logout = document.paths['/api/auth/logout']?.post;
    expect(logout?.operationId).toBe('logout');
    expect(logout?.responses).toHaveProperty('204');
  });

  it('documents the project endpoints with their Zod-derived schemas', () => {
    const document = createOpenApiDocument(app);

    const create = document.paths['/api/projects']?.post;
    expect(create?.operationId).toBe('createProject');
    expect(create?.requestBody).toMatchObject({
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/CreateProjectRequest' } },
      },
    });
    expect(document.components?.schemas?.CreateProjectRequest).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
      required: ['name'],
    });
    expect(create?.responses['201']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Project_Output' } } },
    });
    expect(document.components?.schemas?.Project_Output).toMatchObject({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
      required: ['id', 'name', 'createdAt'],
    });

    const list = document.paths['/api/projects']?.get;
    expect(list?.operationId).toBe('listProjects');
    expect(list?.responses['200']).toMatchObject({
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/ProjectList_Output' } },
      },
    });
    expect(document.components?.schemas?.ProjectList_Output).toMatchObject({
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/Project_Output' } },
      },
      required: ['items'],
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
