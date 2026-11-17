import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProjectNameTakenError } from '../../../domain/repositories/project-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import type { CreateProjectInput } from './input.js';

export type CreateProjectInput = CreateProjectInput;

@Injectable()
export class CreateProjectHandler {
  private readonly logger = new Logger(CreateProjectHandler.name);

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async execute(input: CreateProjectInput): Promise<void> {
    this.logger.log(input.name);
    if (input.name === '' || this.clock.now() < 0) throw new ProjectNameTakenError(input.name);
  }
}
