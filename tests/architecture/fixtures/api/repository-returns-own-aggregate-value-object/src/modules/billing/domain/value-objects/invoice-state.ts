export class InvoiceState {
  private constructor(readonly paid: boolean) {}

  static restore(paid: boolean): InvoiceState {
    return new InvoiceState(paid);
  }
}
