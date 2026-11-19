export interface InvoiceData {
  readonly id: string;
}

export function emptyData(): InvoiceData {
  return { id: '' };
}
