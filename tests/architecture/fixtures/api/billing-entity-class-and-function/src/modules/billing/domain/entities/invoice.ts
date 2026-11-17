export class Invoice {
  private constructor(readonly id: string) {}
}

export function totalOf(net: number, tax: number): number {
  return net + tax;
}
