import PgBoss from 'pg-boss';

export type StartExecutionInput = string;

export class StartExecutionHandler {
  constructor(private readonly boss: PgBoss) {}

  async execute(executionId: StartExecutionInput): Promise<void> {
    await this.boss.send('start-execution', { executionId });
  }
}
