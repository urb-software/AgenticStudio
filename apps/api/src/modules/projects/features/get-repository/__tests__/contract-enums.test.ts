import { describe, expect, it } from 'vitest';
import {
  repositoryFailureCodeSchema,
  repositoryStateSchema,
} from '../../../contracts/http/repository-response.js';
import {
  REPOSITORY_FAILURE_CODES,
  REPOSITORY_STATES,
} from '../../../domain/entities/repository.js';
import { GIT_FAILURE_REASONS } from '../../../ports/repository-git.js';

// contracts/http may not import the domain (backend.md §2), so the HTTP enums are a second
// list; this pins them to the domain's (and the Git port's) so they cannot drift apart.
describe('Repository enums of the HTTP contract', () => {
  it('lists exactly the domain states', () => {
    expect(repositoryStateSchema.options).toEqual([...REPOSITORY_STATES]);
  });

  it('lists exactly the domain failure codes, which are the Git failure reasons', () => {
    expect(repositoryFailureCodeSchema.options).toEqual([...REPOSITORY_FAILURE_CODES]);
    expect([...REPOSITORY_FAILURE_CODES]).toEqual([...GIT_FAILURE_REASONS]);
  });
});
