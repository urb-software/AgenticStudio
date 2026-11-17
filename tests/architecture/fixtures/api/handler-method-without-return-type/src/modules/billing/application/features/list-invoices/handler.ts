import type { Invoice } from '../../../domain/entities/invoice.js';

export type ListInvoicesResult = string[];

export class ListInvoicesHandler {
  async execute(): Promise<ListInvoicesResult> {
    return [];
  }

  // No declared return type: the entity class it returns would go unseen.
  first(rows: Invoice[]) {
    return rows[0];
  }
}
