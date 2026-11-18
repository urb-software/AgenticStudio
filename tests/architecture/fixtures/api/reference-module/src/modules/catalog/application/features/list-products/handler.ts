import type { ProductRepository } from '../../../domain/repositories/product-repository.js';
import type { ProductSnapshot } from '../../../domain/value-objects/product-snapshot.js';

export type ListProductsResult = ProductSnapshot[];

export class ListProductsHandler {
  constructor(private readonly products: ProductRepository) {}

  async execute(): Promise<ListProductsResult> {
    return this.products.listNewestFirst();
  }
}
