// A handler loads, calls the domain and saves; it knows only domain abstractions and ports. It
// declares its own input and result types and returns plain data, never an entity class.
import { Product } from '../../../domain/entities/product.js';
import type { ProductRepository } from '../../../domain/repositories/product-repository.js';
import { ProductNameTakenError } from '../../../domain/value-objects/product-errors.js';
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
    if ((await this.products.findByName(input.name)) !== null) throw new ProductNameTakenError();
    const product = Product.create(input.name, this.clock.now());
    await this.products.add(product);
    return product.snapshot();
  }
}
