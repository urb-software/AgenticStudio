export interface GetProjectInput {
  projectId: string;
}

export interface GetProjectResult {
  id: string;
  name: string;
}

export class GetProjectHandler {
  async execute(input: GetProjectInput): Promise<GetProjectResult> {
    return { id: input.projectId, name: 'Shop' };
  }
}
