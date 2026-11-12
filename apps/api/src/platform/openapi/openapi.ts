import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, getSchemaPath, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { PROBLEM_JSON, ProblemDetailsDto } from '../http/problem-details.js';

/**
 * Builds the canonical OpenAPI 3.1 document from the Zod-backed controllers.
 * Needs no listening server or database: Swagger only reads route metadata.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('AI Agent Studio API')
    .setVersion('0.0.0')
    .setOpenAPIVersion('3.1.0')
    // Every error status is problem+json (ProblemDetailsFilter), so document it once.
    .addGlobalResponse({
      status: 'default',
      description: 'Error (RFC 9457 problem details)',
      content: { [PROBLEM_JSON]: { schema: { $ref: getSchemaPath(ProblemDetailsDto) } } },
    })
    .build();
  const document = SwaggerModule.createDocument(app, config, { extraModels: [ProblemDetailsDto] });
  return cleanupOpenApiDoc(document, { version: '3.1' });
}
