import { InvoiceAlreadyPaidError } from '../errors/invoice-errors.js';
import { Money } from '../value-objects/money.js';
import type { InvoiceSnapshot } from './invoice-snapshot.js';

export class Invoice {
  private constructor(
    readonly id: string,
    private readonly total: Money,
    private paid: boolean,
  ) {}

  static create(id: string, amount: number): Invoice {
    return new Invoice(id, Money.of(amount), false);
  }

  pay(): void {
    if (this.paid) throw new InvoiceAlreadyPaidError();
    this.paid = true;
  }

  snapshot(): InvoiceSnapshot {
    return { id: this.id, amount: this.total.amount, paid: this.paid };
  }
}
