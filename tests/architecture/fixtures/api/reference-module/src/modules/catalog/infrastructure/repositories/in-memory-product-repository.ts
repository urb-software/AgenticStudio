import type { Product } from '../../domain/entities/product.js';
import type { ProductRepository } from '../../domain/repositories/product-repository.js';
import { ProductNameTakenError } from '../../domain/value-objects/product-errors.js';
import type { ProductSnapshot } from '../../domain/value-objects/product-snapshot.js';

export class InMemoryProductRepository implements ProductRepository {
  private readonly rows: Product[] = [];

  async add(product: Product): Promise<void> {
    // A database adapter relies on a unique index here; the in-memory one checks synchronously.
    if (this.rows.some((row) => row.snapshot().name === product.snapshot().name)) {
      throw new ProductNameTakenError();
    }
    this.rows.push(product);
  }

  async findById(id: string): Promise<Product | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async listNewestFirst(): Promise<ProductSnapshot[]> {
    return this.rows.map((row) => row.snapshot()).sort((a, b) => b.addedAt - a.addedAt);
  }
}
