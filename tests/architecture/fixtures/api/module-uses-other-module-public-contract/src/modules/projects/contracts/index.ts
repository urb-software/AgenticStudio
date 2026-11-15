export const RUN_START_POINTS = Symbol('RUN_START_POINTS');

export interface RunStartPoints {
  forProject(projectId: string): Promise<string | null>;
}
