import type {
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
  RunningProcess,
} from '../../process-runner.js';

export type Call = Omit<ProcessOptions, 'signal' | 'onLine'> & { signal?: AbortSignal };

export type Responder = (call: Call, emit: (line: string) => void) => Partial<ProcessResult> | void;

/** A process runner that records every call and answers from a script; it starts no process. */
export class RecordingRunner implements ProcessRunner {
  readonly calls: Call[] = [];
  readonly started: Omit<ProcessOptions, 'timeoutMs'>[] = [];

  constructor(private readonly respond: Responder = () => ({})) {}

  async run(options: ProcessOptions): Promise<ProcessResult> {
    this.calls.push(options);
    const answer =
      this.respond(options, (line) => options.onLine?.('stdout', line)) ??
      ({} as Partial<ProcessResult>);
    return { exitCode: 0, stdout: '', stderr: '', interrupted: null, ...answer };
  }

  start(options: Omit<ProcessOptions, 'timeoutMs'>): RunningProcess {
    this.started.push(options);
    const exited = new Promise<ProcessResult>(() => undefined);
    return { pid: 4242, exited, stop: async () => undefined };
  }

  argsOf(index: number): string[] {
    return [...this.calls[index]!.args];
  }
}
