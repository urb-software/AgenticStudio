/** The controller's own journal log, whose fields cannot carry a secret. */
export interface LogFields {
  operationId?: string;
  projectId?: string;
  kind?: string;
  outcome?: string;
}

export interface ControllerLogger {
  event(name: string, fields?: LogFields): void;
}

const KEYS = ['operationId', 'projectId', 'kind', 'outcome'] as const;

export class JsonLineLogger implements ControllerLogger {
  constructor(
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly now: () => Date = () => new Date(),
  ) {}

  event(name: string, fields: LogFields = {}): void {
    const entry: Record<string, string> = { at: this.now().toISOString(), event: name };
    for (const key of KEYS) {
      const value = fields[key];
      if (typeof value === 'string') entry[key] = value;
    }
    this.write(JSON.stringify(entry));
  }
}
