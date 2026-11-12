import { Module } from '@nestjs/common';
import { PrismaProjectRepository } from './modules/projects/infrastructure/repositories/prisma-project-repository.js';

@Module({ providers: [PrismaProjectRepository] })
export class AppModule {}
