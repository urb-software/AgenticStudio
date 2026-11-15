import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import { baseConfig, prettierConfig } from '../../eslint.base.mjs';

/**
 * Ways to load code that the dependency graph (architecture:monorepo) cannot see, banned in
 * the worker's production code so nothing reaches node:child_process past the spawn boundary
 * (Issue #101, review of #116).
 */
const LOADER_PROPERTIES = '/^(binding|_linkedBinding|dlopen|getBuiltinModule)$/';

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
    // The process loader properties, on any object (globalThis.process, an alias), dotted or
    // as a string key (review round 2 of #116).
    {
      selector: `MemberExpression[property.name=${LOADER_PROPERTIES}]`,
      message: 'process loader properties are not allowed in the agent worker.',
    },
    {
      selector: `MemberExpression[property.value=${LOADER_PROPERTIES}]`,
      message: 'process loader properties are not allowed in the agent worker.',
    },
    {
      selector: `Property[key.name=${LOADER_PROPERTIES}]`,
      message: 'process loader properties are not allowed in the agent worker (destructuring).',
    },
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: ['vm', 'node:vm'].map((name) => ({
        name,
        message: 'node:vm runs code the gate cannot see; not allowed in the agent worker.',
      })),
    },
  ],
  'no-eval': 'error',
  'no-new-func': 'error',
  'no-implied-eval': 'error',
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
