import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  type EnvironmentFileInfoResponse,
  environmentFileInfoSchema,
  toEnvironmentFileInfoResponse,
} from '../../shared/environment-file-response.js';
import { PROJECTS_PROBLEM_TYPES, projectNotFound } from '../../shared/problems.js';
import { GetEnvironmentFileHandler } from '../../../../application/features/get-environment-file/handler.js';
import { ProjectNotFoundError } from '../../../../domain/errors/project-errors.js';

/**
 * `GET /api/projects/:id/environment-file` (Issue #104), behind the global session guard: the
 * Environment file's path, size and last change, or `null` when none is set. Never the content.
 */
@ApiTags('projects')
@Controller('projects')
export class GetEnvironmentFileEndpoint {
  constructor(private readonly handler: GetEnvironmentFileHandler) {}

  @Get(':id/environment-file')
  @ApiOperation({ operationId: 'getEnvironmentFile' })
  // Not @ZodResponse: the body may be `null`, which a DTO cannot describe; the closed schema
  // still serializes it below, so nothing but these fields can leave.
  @ApiOkResponse({
    description: 'The Environment file, or null when none is set',
    schema: {
      nullable: true,
      // The component the PUT response registers (nestjs-zod names output schemas `<id>_Output`).
      allOf: [{ $ref: '#/components/schemas/EnvironmentFileInfo_Output' }],
    },
  })
  @ApiProblemResponses({ 404: `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound})` })
  async get(
    @Param('id') id: string,
    // Nest sends an empty body for a `null` return value; the contract's `null` is written as
    // JSON here (the body is still the closed schema's output, or `null`).
    @Res() response: { status(code: number): { json(body: unknown): void } },
  ): Promise<void> {
    let info;
    try {
      info = await this.handler.execute({ projectId: id });
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw projectNotFound();
      throw error;
    }
    const body: EnvironmentFileInfoResponse | null = info
      ? environmentFileInfoSchema.parse(toEnvironmentFileInfoResponse(info))
      : null;
    response.status(200).json(body);
  }
}
