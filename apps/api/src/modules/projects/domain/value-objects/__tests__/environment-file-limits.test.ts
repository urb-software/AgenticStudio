import {
  ENVIRONMENT_FILE_MAX_BYTES,
  ENVIRONMENT_FILE_PATH_MAX_LENGTH,
  environmentFilePathProblem,
} from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { InvalidEnvironmentFilePathError } from '../../errors/environment-file-errors.js';
import { EnvironmentFileContent } from '../environment-file-content.js';
import { EnvironmentFilePath } from '../environment-file-path.js';

describe('the Environment file limits follow the worker protocol', () => {
  it('has the same size and path length limits', () => {
    expect(EnvironmentFileContent.MAX_BYTES).toBe(ENVIRONMENT_FILE_MAX_BYTES);
    expect(EnvironmentFilePath.MAX_LENGTH).toBe(ENVIRONMENT_FILE_PATH_MAX_LENGTH);
  });

  it.each([
    '',
    '.env',
    'config/.env.local',
    'a'.repeat(255),
    'a'.repeat(256),
    'with\u0000control',
    'back\\slash',
    '/absolute',
    '../up',
    'a/../b',
    './here',
    'a//b',
    'a/',
    '.git/config',
    'a/.GIT/x',
  ])('judges the path %j like the protocol', (path) => {
    const problem = environmentFilePathProblem(path);
    if (problem === null) {
      expect(EnvironmentFilePath.of(path).value).toBe(path);
    } else {
      expect(() => EnvironmentFilePath.of(path)).toThrow(
        new InvalidEnvironmentFilePathError(problem),
      );
    }
  });
});
