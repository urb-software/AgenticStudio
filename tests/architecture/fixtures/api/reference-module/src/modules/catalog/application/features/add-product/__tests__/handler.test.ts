// The tests of a feature sit beside it and use fakes of the repository interface and the ports,
// never the concrete adapters.
import type { Product } from '../../../../domain/entities/product.js';
import type { ProductRepository } from '../../../../domain/repositories/product-repository.js';
import type { ProductSnapshot } from '../../../../domain/value-objects/product-snapshot.js';
import { AddProductHandler } from '../handler.js';

class FakeProductRepository implements ProductRepository {
  readonly rows: Product[] = [];

  async add(product: Product): Promise<void> {
    this.rows.push(product);
  }

  async findByName(name: string): Promise<Product | null> {
    return this.rows.find((row) => row.snapshot().name === name) ?? null;
  }

  async listNewestFirst(): Promise<ProductSnapshot[]> {
    return this.rows.map((row) => row.snapshot());
  }
}

export async function addsAProduct(): Promise<boolean> {
  const handler = new AddProductHandler(new FakeProductRepository(), { now: () => 1 });
  return (await handler.execute({ name: 'Tea' })).name === 'Tea';
}
