import type { ProductRepository } from '../../../domain/repositories/product-repository.js';

export type ListProductsResult = { id: string; name: string; addedAt: number }[];

export class ListProductsHandler {
  constructor(private readonly products: ProductRepository) {}

  async execute(): Promise<ListProductsResult> {
    return (await this.products.listNewestFirst()).map((product) => ({
      id: product.id,
      name: product.name.value,
      addedAt: product.addedAt,
    }));
  }
}
