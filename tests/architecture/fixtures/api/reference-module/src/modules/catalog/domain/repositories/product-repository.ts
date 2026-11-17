// A repository interface serves one aggregate root and lives in the domain; its implementation
// is in infrastructure/repositories/. It returns the root, or the root's snapshot for a read.
import type { Product } from '../entities/product.js';
import type { ProductSnapshot } from '../value-objects/product-snapshot.js';

export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');

export interface ProductRepository {
  add(product: Product): Promise<void>;
  findByName(name: string): Promise<Product | null>;
  listNewestFirst(): Promise<ProductSnapshot[]>;
}
