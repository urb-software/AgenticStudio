import type { Clock } from './ports/clock.js';
import { InvoiceNumber } from '../domain/value-objects/invoice-number.js';

export class InvoiceNumbering {
  constructor(private readonly clock: Clock) {}

  next(sequence: number): InvoiceNumber {
    return InvoiceNumber.of(this.clock.now(), sequence);
  }
}
