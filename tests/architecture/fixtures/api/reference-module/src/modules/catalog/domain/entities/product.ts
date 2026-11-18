import { ProductName } from '../value-objects/product-name.js';
import type { ProductSnapshot } from './product-snapshot.js';

// An aggregate root is a class with its own id and a non-public constructor: only its factories
// make one, so it cannot be built in an invalid state. It produces its snapshot, the plain data
// that only its repository sees. The file holds the class and nothing else (one concept per
// file).
export class Product {
  private constructor(
    readonly id: string,
    readonly name: ProductName,
    readonly addedAt: number,
  ) {}

  static create(id: string, name: string, now: number): Product {
    return new Product(id, ProductName.of(name), now);
  }

  static restore(snapshot: ProductSnapshot): Product {
    return new Product(snapshot.id, ProductName.of(snapshot.name), snapshot.addedAt);
  }

  snapshot(): ProductSnapshot {
    return { id: this.id, name: this.name.value, addedAt: this.addedAt };
  }
}
