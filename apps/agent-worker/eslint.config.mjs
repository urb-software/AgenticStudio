import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import { baseConfig, prettierConfig } from '../../eslint.base.mjs';

/**
 * Ways to load code that the dependency graph (architecture:monorepo) cannot see, banned in
 * the worker's production code so nothing reaches node:child_process past the spawn boundary
 * (Issue #101, review of #116).
 */
export const HIDDEN_LOADING_RULES = {
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ImportExpression[source.type!="Literal"]',
      message: 'import() takes a literal module name in the agent worker (the gate must see it).',
    },
    {
      selector: 'CallExpression[callee.name="require"]',
      message: 'No require() in the agent worker: use a static import the gate can see.',
    },
    {
      selector: 'Identifier[name="createRequire"]',
      message: 'No createRequire in the agent worker: it loads modules the gate cannot see.',
    },
  ],
  'no-restricted-properties': [
    'error',
    ...['binding', '_linkedBinding', 'dlopen'].map((property) => ({
      object: 'process',
      property,
      message: `process.${property} is not allowed in the agent worker.`,
    })),
  ],
};

export default defineConfig([
  globalIgnores(['dist/**']),
  ...baseConfig,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/__tests__/**'],
    rules: HIDDEN_LOADING_RULES,
  },
  prettierConfig,
]);
