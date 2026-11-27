import { type DynamicModule, Module } from '@nestjs/common';
import { AgentsModule } from './modules/agents/agents.module.js';
import {
  EnvironmentsModule,
  type EnvironmentsModuleOptions,
} from './modules/environments/environments.module.js';
import {
  ExecutionsModule,
  type ExecutionsModuleOptions,
} from './modules/executions/executions.module.js';
import { ProjectsModule, type ProjectsModuleOptions } from './modules/projects/projects.module.js';
import { WorkflowPlansModule, WorkflowsModule } from './modules/workflows/workflows.module.js';
import { AuthModule } from './platform/auth/auth.module.js';
import type { AppConfig } from './platform/config/config.js';
import { ConfigModule } from './platform/config/config.module.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { HealthModule } from './platform/health/health.module.js';
import { HttpModule } from './platform/http/http.module.js';
import { QueueModule, type QueueWorkerTuning } from './platform/queue/queue.module.js';
import { SecretsModule } from './platform/secrets/secrets.module.js';

@Module({})
export class AppModule {
  /** Test seams; production passes none. `{ startWorkers: false }` builds without Redis. */
  static register(
    config: AppConfig,
    options: {
      queue?: QueueWorkerTuning;
      projects?: ProjectsModuleOptions;
      executions?: ExecutionsModuleOptions;
      environments?: EnvironmentsModuleOptions;
    } = {},
  ): DynamicModule {
    // One instance each: `executions`, `environments`, `agents` and `workflows` import `projects`;
    // `executions` imports `environments`, `agents` and the plans `workflows` provides, and
    // `workflows` imports `agents` and `executions`, to reach their public contracts.
    const projects = ProjectsModule.register(options.projects);
    const agents = AgentsModule.register(projects);
    const environments = EnvironmentsModule.register(projects, options.environments);
    // Provides the order of a Workflow's Phases to `executions`, which imports nothing of it.
    const workflowPlans = WorkflowPlansModule.register(projects, agents);
    const executions = ExecutionsModule.register(
      projects,
      environments,
      agents,
      workflowPlans,
      options.executions,
    );
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule,
        HttpModule,
        QueueModule.forRoot(options.queue),
        HealthModule,
        SecretsModule,
        AuthModule,
        projects,
        agents,
        executions,
        environments,
        WorkflowsModule.register(projects, agents, executions, workflowPlans),
      ],
    };
  }
}
