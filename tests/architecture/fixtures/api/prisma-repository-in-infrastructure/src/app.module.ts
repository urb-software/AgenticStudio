import { Module } from '@nestjs/common';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { DatabaseModule } from './platform/database/database.module.js';

@Module({ imports: [DatabaseModule, ProjectsModule] })
export class AppModule {}
