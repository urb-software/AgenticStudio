// The module file wires handlers, entry points and adapters; only the composition root imports it.
import { AddProductHandler } from './application/features/add-product/handler.js';
import { ListProductsHandler } from './application/features/list-products/handler.js';
import { AddProductEndpoint } from './entry-points/http/operator/add-product/endpoint.js';
import { ListProductsEndpoint } from './entry-points/http/operator/list-products/endpoint.js';
import { SystemClock } from './infrastructure/adapters/system-clock.js';
import { InMemoryProductRepository } from './infrastructure/repositories/in-memory-product-repository.js';

const products = new InMemoryProductRepository();
const clock = new SystemClock();
const addProduct = new AddProductHandler(products, clock);
const listProducts = new ListProductsHandler(products);

export const CatalogModule = {
  addProduct: new AddProductEndpoint(addProduct),
  listProducts: new ListProductsEndpoint(listProducts),
};
