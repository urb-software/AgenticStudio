import type { WorkerDisk } from '@agentic-studio/contracts';

export type GetInvoiceResult = WorkerDisk;

export class GetInvoiceHandler {
  constructor(private readonly source: () => Promise<WorkerDisk>) {}

  execute(): Promise<GetInvoiceResult> {
    return this.source();
  }
}
