import { Injectable } from '@nestjs/common';
import type { MergeMethod } from '@agentic-studio/contracts';
import type { RunMergeMethods } from '../../contracts/index.js';
import { GetRunMergeMethodHandler } from '../../application/features/get-run-merge-method/handler.js';

@Injectable()
export class ProjectRunMergeMethods implements RunMergeMethods {
  constructor(private readonly handler: GetRunMergeMethodHandler) {}

  mergeMethodFor(projectId: string): Promise<MergeMethod> {
    return this.handler.execute({ projectId });
  }
}
