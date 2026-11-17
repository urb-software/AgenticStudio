export type ProjectId = string & { readonly __projectId: unique symbol };

export const PROJECT_ID_LENGTH = 36;

export class ProjectIdFormat {
  private constructor(readonly length: number) {}

  static standard(): ProjectIdFormat {
    return new ProjectIdFormat(PROJECT_ID_LENGTH);
  }
}

export function isProjectId(value: string): value is ProjectId {
  return value.length === PROJECT_ID_LENGTH;
}

export const isProjectIdText = (value: string): value is ProjectId => isProjectId(value);
