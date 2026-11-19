import { ProductName } from '../value-objects/product-name.js';
import type { ProductData } from './product-data.js';

// An aggregate root is a class with its own id and a non-public constructor: only its factories
// make one, so it cannot be built in an invalid state. It is restored from its data and read
// through its fields. The file holds the class and nothing else (one concept per file).
export class Product {
  private constructor(
    readonly id: string,
    readonly name: ProductName,
    readonly addedAt: number,
  ) {}

  static create(id: string, name: string, now: number): Product {
    return new Product(id, ProductName.of(name), now);
  }

  static restore(data: ProductData): Product {
    return new Product(data.id, ProductName.of(data.name), data.addedAt);
  }
}
