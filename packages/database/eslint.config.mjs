import { defineConfig, globalIgnores } from 'eslint/config';
import { baseConfig, prettierConfig } from '../../eslint.base.mjs';

export default defineConfig([
  globalIgnores(['dist/**', 'src/generated/**']),
  ...baseConfig,
  prettierConfig,
]);
