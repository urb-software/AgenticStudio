export type InvoiceId = string & { readonly __invoiceId: unique symbol };

export function isInvoiceId(value: string): value is InvoiceId {
  return value.length > 0;
}
