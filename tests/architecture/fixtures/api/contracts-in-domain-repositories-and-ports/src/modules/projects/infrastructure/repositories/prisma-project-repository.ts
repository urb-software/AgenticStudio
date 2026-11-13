import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  ProjectNameTakenError,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';

@Injectable()
export class PrismaProjectRepository implements ProjectRepository, OnModuleInit {
  private readonly names = new Set<string>();

  onModuleInit(): void {}

  async add(name: string): Promise<void> {
    if (this.names.has(name)) throw new ProjectNameTakenError();
    this.names.add(name);
  }
}
