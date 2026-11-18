export class Currency {
  static readonly DEFAULT = 'EUR';

  constructor(readonly code: string = Currency.DEFAULT) {}
}
