import { InvalidProductNameError } from '../errors/product-errors.js';

// A value object validates on creation.
export class ProductName {
  private constructor(readonly value: string) {}

  static of(raw: string): ProductName {
    const value = raw.trim();
    if (value === '') throw new InvalidProductNameError();
    return new ProductName(value);
  }
}
