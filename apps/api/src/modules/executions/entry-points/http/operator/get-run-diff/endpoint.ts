import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  runDiffFileNotFound,
  runDiffNotFound,
  runNotFound,
} from '../../shared/problems.js';
import {
  GetRunDiffHandler,
  RunDiffNotFoundError,
} from '../../../../application/features/get-run-diff/handler.js';
import {
  GetRunDiffFileHandler,
  RunDiffFileNotFoundError,
} from '../../../../application/features/get-run-diff-file/handler.js';
import {
  GetRunDiffFileQueryDto,
  GetRunDiffQueryDto,
  RunDiffDto,
  RunDiffFileDto,
} from './schema.js';
import { RunNotFoundError } from '../../../../domain/value-objects/run-errors.js';

/**
 * `GET /api/runs/:runId/diff?scope=run|last` and `GET /api/runs/:runId/diff/file?scope=&path=`
 * (Issue #144), behind the global session guard: a Run's diff (the file list) and one file's
 * patch. 404 for an unknown Run, a Run without a diff yet, or a path the diff does not list.
 */
@ApiTags('runs')
@Controller('runs')
export class GetRunDiffEndpoint {
  constructor(
    private readonly diffHandler: GetRunDiffHandler,
    private readonly fileHandler: GetRunDiffFileHandler,
  ) {}

  @Get(':runId/diff')
  @ApiOperation({ operationId: 'getRunDiff' })
  @ZodResponse({ status: 200, type: RunDiffDto })
  @ApiProblemResponses({
    400: 'Invalid scope',
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound}) or no diff yet (${EXECUTIONS_PROBLEM_TYPES.runDiffNotFound})`,
  })
  async diff(@Param('runId') runId: string, @Query() query: GetRunDiffQueryDto) {
    try {
      const diff = await this.diffHandler.execute({ runId, scope: query.scope });
      if (diff.kind === 'unavailable') {
        // No pushed state for a diff that was not computed (review S-3 of #149).
        return {
          scope: query.scope,
          truncated: false,
          files: [],
          unavailableReason: diff.reason,
        };
      }
      return {
        scope: query.scope,
        baseCommit: diff.baseCommit,
        includesUnpushed: diff.includesUnpushed,
        truncated: diff.truncated,
        files: diff.files.map(({ hasPatch, ...file }) => {
          void hasPatch;
          return file;
        }),
      };
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunDiffNotFoundError) throw runDiffNotFound();
      throw error;
    }
  }

  @Get(':runId/diff/file')
  @ApiOperation({ operationId: 'getRunDiffFile' })
  @ZodResponse({ status: 200, type: RunDiffFileDto })
  @ApiProblemResponses({
    400: 'Invalid scope or path',
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound}) or file not in the diff (${EXECUTIONS_PROBLEM_TYPES.runDiffFileNotFound})`,
  })
  async file(@Param('runId') runId: string, @Query() query: GetRunDiffFileQueryDto) {
    try {
      const file = await this.fileHandler.execute({
        runId,
        scope: query.scope,
        path: query.path,
      });
      return {
        path: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        status: file.status,
        ...(file.patch === undefined ? {} : { patch: file.patch }),
        ...(file.tooLarge ? { tooLarge: true as const } : {}),
        ...(file.binary ? { binary: true as const } : {}),
      };
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunDiffFileNotFoundError) throw runDiffFileNotFound();
      throw error;
    }
  }
}
