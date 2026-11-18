export interface InvoiceSnapshot {
  readonly id: string;
}

export function emptySnapshot(): InvoiceSnapshot {
  return { id: '' };
}
