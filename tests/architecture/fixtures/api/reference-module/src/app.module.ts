// The composition root: it imports a module only through its module file.
import { CatalogModule } from './modules/catalog/catalog.module.js';

export const APP_MODULES = [CatalogModule];
