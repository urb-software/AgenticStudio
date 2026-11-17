import type { Product } from '../../domain/entities/product.js';
import type { ProductRepository } from '../../domain/repositories/product-repository.js';
import type { ProductSnapshot } from '../../domain/value-objects/product-snapshot.js';

export class InMemoryProductRepository implements ProductRepository {
  private readonly rows: Product[] = [];

  async add(product: Product): Promise<void> {
    this.rows.push(product);
  }

  async findByName(name: string): Promise<Product | null> {
    return this.rows.find((row) => row.snapshot().name === name) ?? null;
  }

  async listNewestFirst(): Promise<ProductSnapshot[]> {
    return this.rows.map((row) => row.snapshot()).sort((a, b) => b.addedAt - a.addedAt);
  }
}
