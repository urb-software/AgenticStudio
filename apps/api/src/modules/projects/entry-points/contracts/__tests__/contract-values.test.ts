import { describe, expect, expectTypeOf, it } from 'vitest';
import { type ProjectKind, REPOSITORY_STATES } from '../../../contracts/index.js';
import {
  type ProjectKind as DomainProjectKind,
  PROJECT_KIND_VALUES,
} from '../../../domain/value-objects/project-kind.js';
import { REPOSITORY_STATES as DOMAIN_REPOSITORY_STATES } from '../../../domain/value-objects/repository-state.js';

describe('values the public face repeats', () => {
  it('lists the Repository states of the domain', () => {
    expect([...REPOSITORY_STATES]).toEqual([...DOMAIN_REPOSITORY_STATES]);
  });

  it('keeps the two Project kinds the contract names', () => {
    expect([...PROJECT_KIND_VALUES]).toEqual(['code', 'definitions']);
    expectTypeOf<ProjectKind>().toEqualTypeOf<DomainProjectKind>();
  });
});
