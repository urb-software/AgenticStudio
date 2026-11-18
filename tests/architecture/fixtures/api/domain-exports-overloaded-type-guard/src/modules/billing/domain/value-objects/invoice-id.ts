export function isInvoiceId(value: unknown): value is string;
export function isInvoiceId(value: unknown, strict: true): value is `inv_${string}`;
export function isInvoiceId(value: unknown, strict?: boolean): boolean {
  return typeof value === 'string' && (!strict || value.startsWith('inv_'));
}
