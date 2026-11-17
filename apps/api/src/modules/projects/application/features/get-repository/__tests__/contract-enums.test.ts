import { describe, expect, it } from 'vitest';
import {
  repositoryFailureCodeSchema,
  repositoryStateSchema,
} from '../../../../entry-points/http/shared/repository-response.js';
import { REPOSITORY_STATES } from '../../../../domain/value-objects/repository-state.js';
import { REPOSITORY_FAILURE_CODES } from '../../../../domain/value-objects/repository-failure.js';

// contracts/http may not import the domain (backend.md §2), so the HTTP enums are a second
// list; this pins them to the domain's so they cannot drift apart. The Git port's failure
// reasons are the domain's list itself (`GIT_FAILURE_REASONS`), not a copy.
describe('Repository enums of the HTTP contract', () => {
  it('lists exactly the domain states', () => {
    expect(repositoryStateSchema.options).toEqual([...REPOSITORY_STATES]);
  });

  it('lists exactly the domain failure codes', () => {
    expect(repositoryFailureCodeSchema.options).toEqual([...REPOSITORY_FAILURE_CODES]);
  });
});
