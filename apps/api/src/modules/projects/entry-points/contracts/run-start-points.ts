import { Injectable } from '@nestjs/common';
import type { RunStartPoint, RunStartPoints } from '../../contracts/index.js';
import { GetRunStartPointHandler } from '../../application/features/get-run-start-point/handler.js';

/**
 * The driving adapter for another module's call through `contracts/`: it maps the call to the
 * handler and holds no rule.
 */
@Injectable()
export class ProjectRunStartPoints implements RunStartPoints {
  constructor(private readonly handler: GetRunStartPointHandler) {}

  forProject(projectId: string): Promise<RunStartPoint> {
    return this.handler.execute({ projectId });
  }
}
