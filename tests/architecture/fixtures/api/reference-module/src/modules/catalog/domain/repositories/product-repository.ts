// A repository interface serves one aggregate root and lives in the domain; its implementation
// is in infrastructure/repositories/. It returns the root.
import type { Product } from '../entities/product.js';

export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');

export interface ProductRepository {
  /**
   * Persists a new product. Throws `ProductNameTakenError` when a product with the same name
   * exists, also when a concurrent request created it first.
   *
   * Atomic operation: the unique index on the name decides a simultaneous create, because there
   * is no row to lock before it exists. A handler therefore does not check and then add.
   */
  add(product: Product): Promise<void>;

  /** The product with this id, or `null`. */
  findById(id: string): Promise<Product | null>;

  /** Every product, newest first. */
  listNewestFirst(): Promise<Product[]>;
}
