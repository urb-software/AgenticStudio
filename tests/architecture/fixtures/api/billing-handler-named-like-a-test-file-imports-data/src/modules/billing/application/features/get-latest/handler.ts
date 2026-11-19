import type { LatestInvoice } from './get-latest.js';

export type GetLatestResult = { readonly id: string };

export class GetLatestHandler {
  constructor(private readonly source: () => Promise<LatestInvoice>) {}

  execute(): Promise<GetLatestResult> {
    return this.source();
  }
}
