import { ListProductsHandler } from '../../../../application/features/list-products/handler.js';
import type { ProductResponse } from '../../shared/product-response.js';

export class ListProductsEndpoint {
  constructor(private readonly handler: ListProductsHandler) {}

  async list(): Promise<ProductResponse[]> {
    return (await this.handler.execute()).map((product) => ({
      name: product.name,
      addedAt: product.addedAt,
    }));
  }
}
