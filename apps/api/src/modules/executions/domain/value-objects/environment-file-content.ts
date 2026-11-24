import { environmentFileValuesToRedact } from '@agentic-studio/log-redaction';

export class EnvironmentFileContent {
  private constructor(private readonly content: string) {}

  static of(content: string): EnvironmentFileContent {
    return new EnvironmentFileContent(content);
  }

  valuesToRedact(): string[] {
    return environmentFileValuesToRedact(this.content);
  }
}
