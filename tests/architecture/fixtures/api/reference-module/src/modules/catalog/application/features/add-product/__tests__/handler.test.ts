// The tests of a feature sit beside it and use fakes of the repository interface and the ports,
// never the concrete adapters.
import type { Product } from '../../../../domain/entities/product.js';
import type { ProductRepository } from '../../../../domain/repositories/product-repository.js';
import { ProductNameTakenError } from '../../../../domain/errors/product-errors.js';
import { AddProductHandler } from '../handler.js';

class FakeProductRepository implements ProductRepository {
  readonly rows: Product[] = [];

  async add(product: Product): Promise<void> {
    if (this.rows.some((row) => row.name.value === product.name.value)) {
      throw new ProductNameTakenError();
    }
    this.rows.push(product);
  }

  async findById(id: string): Promise<Product | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async listNewestFirst(): Promise<Product[]> {
    return this.rows;
  }
}

export async function addsAProduct(): Promise<boolean> {
  const handler = new AddProductHandler(new FakeProductRepository(), { now: () => 1 });
  return (await handler.execute({ name: 'Tea' })).name === 'Tea';
}
