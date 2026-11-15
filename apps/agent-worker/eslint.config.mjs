import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import { baseConfig, prettierConfig } from '../../eslint.base.mjs';

export default defineConfig([
  globalIgnores(['dist/**']),
  ...baseConfig,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  prettierConfig,
]);
