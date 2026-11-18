// A handler loads, calls the domain and saves; it knows only domain abstractions and ports. It
// declares its own input and result types and returns plain data, never an entity class.
import { randomUUID } from 'node:crypto';
import { Product } from '../../../domain/entities/product.js';
import type { ProductRepository } from '../../../domain/repositories/product-repository.js';
import type { ProductSnapshot } from '../../../domain/value-objects/product-snapshot.js';
import type { Clock } from '../../ports/clock.js';

export interface AddProductInput {
  name: string;
}

export type AddProductResult = ProductSnapshot;

export class AddProductHandler {
  constructor(
    private readonly products: ProductRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: AddProductInput): Promise<AddProductResult> {
    const product = Product.create(randomUUID(), input.name, this.clock.now());
    // The store refuses a duplicate name with ProductNameTakenError (see ProductRepository.add).
    await this.products.add(product);
    return product.snapshot();
  }
}
