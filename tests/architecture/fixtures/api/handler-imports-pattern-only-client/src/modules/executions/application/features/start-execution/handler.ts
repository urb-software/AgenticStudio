import PgBoss from 'pg-boss';

export class StartExecutionHandler {
  constructor(private readonly boss: PgBoss) {}

  async execute(executionId: string): Promise<void> {
    await this.boss.send('start-execution', { executionId });
  }
}
