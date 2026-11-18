// A handler loads, calls the domain and saves; it knows only domain abstractions and ports. It
// declares its own input and result types and returns plain data, never an entity class.
import { randomUUID } from 'node:crypto';
import { Product } from '../../../domain/entities/product.js';
import type { ProductRepository } from '../../../domain/repositories/product-repository.js';
import type { Clock } from '../../ports/clock.js';

export interface AddProductInput {
  name: string;
}

export interface AddProductResult {
  id: string;
  name: string;
  addedAt: number;
}

export class AddProductHandler {
  constructor(
    private readonly products: ProductRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: AddProductInput): Promise<AddProductResult> {
    const product = Product.create(randomUUID(), input.name, this.clock.now());
    // The store refuses a duplicate name with ProductNameTakenError (see ProductRepository.add).
    await this.products.add(product);
    return { id: product.id, name: product.name.value, addedAt: product.addedAt };
  }
}
