import type { Product } from '../../domain/entities/product.js';
import type { ProductRepository } from '../../domain/repositories/product-repository.js';
import { ProductNameTakenError } from '../../domain/errors/product-errors.js';

export class InMemoryProductRepository implements ProductRepository {
  private readonly rows: Product[] = [];

  async add(product: Product): Promise<void> {
    // A database adapter relies on a unique index here; the in-memory one checks synchronously.
    if (this.rows.some((row) => row.name.value === product.name.value)) {
      throw new ProductNameTakenError();
    }
    this.rows.push(product);
  }

  async findById(id: string): Promise<Product | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async listNewestFirst(): Promise<Product[]> {
    return [...this.rows].sort((a, b) => b.addedAt - a.addedAt);
  }
}
