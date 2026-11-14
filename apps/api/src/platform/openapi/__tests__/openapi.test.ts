import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig, WITHOUT_QUEUE_WORKERS } from '../../../__tests__/test-config.js';
import { createApp } from '../../../app.js';
import { createOpenApiDocument } from '../openapi.js';

describe('OpenAPI document', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Offline: the database client connects lazily and the app never listens.
    app = await createApp(testConfig(), WITHOUT_QUEUE_WORKERS);
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

  it('documents the project detail and repository endpoints (Stories #60, #61 and #63)', () => {
    const document = createOpenApiDocument(app);
    const ref = (name: string) => ({
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
    });
    const problem = {
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
      },
    };

    const detail = document.paths['/api/projects/{id}']?.get;
    expect(detail?.operationId).toBe('getProject');
    expect(detail?.responses['200']).toMatchObject(ref('ProjectDetail_Output'));
    expect(detail?.responses['404']).toMatchObject(problem);
    expect(document.components?.schemas?.ProjectDetail_Output).toMatchObject({
      properties: {
        repository: {
          anyOf: [{ $ref: '#/components/schemas/RepositorySummary_Output' }, { type: 'null' }],
        },
      },
      required: ['id', 'name', 'createdAt', 'repository'],
    });

    const read = document.paths['/api/projects/{id}/repository']?.get;
    expect(read?.operationId).toBe('getRepository');
    expect(read?.responses['200']).toMatchObject(ref('Repository_Output'));

    const connect = document.paths['/api/projects/{id}/repository']?.post;
    expect(connect?.operationId).toBe('connectRepository');
    expect(connect?.requestBody).toMatchObject(ref('ConnectRepositoryRequest'));
    expect(connect?.responses['201']).toMatchObject(ref('Repository_Output'));
    for (const status of ['404', '409', '422', '501']) {
      expect(connect?.responses[status]).toMatchObject(problem);
    }

    const fetch = document.paths['/api/projects/{id}/repository/fetch']?.post;
    expect(fetch?.operationId).toBe('fetchRepository');
    expect(fetch?.requestBody).toBeUndefined();
    expect(fetch?.responses['202']).toMatchObject(ref('Repository_Output'));
    for (const status of ['404', '409', '501', '503']) {
      expect(fetch?.responses[status]).toMatchObject(problem);
    }

    const verify = document.paths['/api/projects/{id}/repository/verify']?.post;
    expect(verify?.operationId).toBe('verifyRepository');
    expect(verify?.requestBody).toMatchObject(ref('VerifyRepositoryRequest'));
    expect(verify?.responses['202']).toMatchObject(ref('Repository_Output'));
    for (const status of ['404', '409', '422', '501', '503']) {
      expect(verify?.responses[status]).toMatchObject(problem);
    }

    const disconnect = document.paths['/api/projects/{id}/repository']?.delete;
    expect(disconnect?.operationId).toBe('disconnectRepository');
    expect(disconnect?.requestBody).toBeUndefined();
    expect(disconnect?.responses['204']).toBeDefined();
    expect(disconnect?.responses['204']).not.toHaveProperty('content');
    expect(disconnect?.responses['202']).toMatchObject(ref('Repository_Output'));
    for (const status of ['404', '501']) {
      expect(disconnect?.responses[status]).toMatchObject(problem);
    }
    // Disconnect wins over a running operation: there is no 409.
    expect(disconnect?.responses['409']).toBeUndefined();

    const schemas = document.components?.schemas ?? {};
    expect(schemas.RepositoryState_Output).toMatchObject({
      enum: [
        'awaiting_key',
        'awaiting_host_key',
        'connecting',
        'ready',
        'fetching',
        'failed',
        'disconnecting',
      ],
    });
    expect(schemas.RepositoryFailureCode_Output).toMatchObject({
      enum: [
        'auth_failed',
        'host_unreachable',
        'host_key_mismatch',
        'repository_not_found',
        'branch_not_found',
        'timeout',
        'size_limit',
        'unknown',
      ],
    });
    // Closed objects: no field beyond the contract can carry key material.
    for (const name of [
      'Repository_Output',
      'RepositorySummary_Output',
      'RepositoryFailure_Output',
    ]) {
      expect(schemas[name]).toMatchObject({ additionalProperties: false });
    }
    expect(Object.keys((schemas.Repository_Output as { properties: object }).properties)).toEqual([
      'state',
      'url',
      'integrationBranch',
      'hasClone',
      'headSha',
      'lastFetchedAt',
      'failure',
      'publicKey',
      'hostKeyFingerprint',
    ]);
    expect(schemas.Repository_Output).toMatchObject({
      required: ['state', 'url', 'integrationBranch', 'hasClone'],
    });
    expect(schemas.ConnectRepositoryRequest).toMatchObject({
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 2048 },
        integrationBranch: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          pattern: expect.any(String),
        },
      },
      required: ['url', 'integrationBranch'],
    });
    // Optional: `{}` verifies the Deploy key; the fingerprint confirms a host key.
    expect(schemas.VerifyRepositoryRequest).toMatchObject({
      properties: { acceptHostKeyFingerprint: { type: 'string', minLength: 1, maxLength: 100 } },
    });
    expect(schemas.VerifyRepositoryRequest).not.toHaveProperty('required');
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
