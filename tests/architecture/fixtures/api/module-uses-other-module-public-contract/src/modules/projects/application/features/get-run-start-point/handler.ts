export type GetRunStartPointInput = { projectId: string };
export type GetRunStartPointResult = string | null;

export class GetRunStartPointHandler {
  async execute(input: GetRunStartPointInput): Promise<GetRunStartPointResult> {
    return input.projectId.length > 0 ? 'abc123' : null;
  }
}
