// An entry point calls a handler; it imports no repository interface, port or infrastructure
// file and no entity class, only domain errors (from the aggregate's errors file) to map them.
import { AddProductHandler } from '../../../../application/features/add-product/handler.js';
import { ProductNameTakenError } from '../../../../domain/value-objects/product-errors.js';
import type { ProductResponse } from '../../shared/product-response.js';
import { AddProductBodySchema } from './schema.js';

export class AddProductEndpoint {
  constructor(private readonly handler: AddProductHandler) {}

  async add(body: unknown): Promise<ProductResponse | 'conflict'> {
    const { name } = AddProductBodySchema.parse(body);
    try {
      const product = await this.handler.execute({ name });
      return { name: product.name, addedAt: product.addedAt };
    } catch (error) {
      if (error instanceof ProductNameTakenError) return 'conflict';
      throw error;
    }
  }
}
