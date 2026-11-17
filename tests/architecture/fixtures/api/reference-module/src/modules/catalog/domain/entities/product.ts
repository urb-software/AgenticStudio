import { ProductName } from '../value-objects/product-name.js';
import type { ProductSnapshot } from '../value-objects/product-snapshot.js';

// An aggregate root is a class with a non-public constructor: only its factories make one, so it
// cannot be built in an invalid state. It produces its snapshot, the plain data that leaves the
// application layer. The file holds the class and nothing else (one concept per file).
export class Product {
  private constructor(
    private readonly name: ProductName,
    private readonly addedAt: number,
  ) {}

  static create(name: string, now: number): Product {
    return new Product(ProductName.of(name), now);
  }

  static restore(snapshot: ProductSnapshot): Product {
    return new Product(ProductName.of(snapshot.name), snapshot.addedAt);
  }

  snapshot(): ProductSnapshot {
    return { name: this.name.value, addedAt: this.addedAt };
  }
}
