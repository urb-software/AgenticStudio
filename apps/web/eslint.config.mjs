import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import { baseConfig, prettierConfig } from '../../eslint.base.mjs';

export default defineConfig([
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
  ...baseConfig,
  ...nextVitals,
  ...nextTs,
  prettierConfig,
]);
