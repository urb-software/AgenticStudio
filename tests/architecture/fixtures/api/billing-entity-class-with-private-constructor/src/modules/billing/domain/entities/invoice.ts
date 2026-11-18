export class Invoice {
  private constructor(readonly state: string) {}

  static issue(): Invoice {
    return new Invoice('issued');
  }
}
