import { Product } from '../../domain/entities/product.js';
import type { ProductSnapshot } from '../../domain/entities/product-snapshot.js';
import type { ProductRepository } from '../../domain/repositories/product-repository.js';
import { ProductNameTakenError } from '../../domain/errors/product-errors.js';

export class InMemoryProductRepository implements ProductRepository {
  private readonly rows: ProductSnapshot[] = [];

  async add(product: Product): Promise<void> {
    // A database adapter relies on a unique index here; the in-memory one checks synchronously.
    if (this.rows.some((row) => row.name === product.name.value)) {
      throw new ProductNameTakenError();
    }
    this.rows.push(product.snapshot());
  }

  async findById(id: string): Promise<Product | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? Product.restore(row) : null;
  }

  async listNewestFirst(): Promise<Product[]> {
    return [...this.rows].sort((a, b) => b.addedAt - a.addedAt).map((row) => Product.restore(row));
  }
}
