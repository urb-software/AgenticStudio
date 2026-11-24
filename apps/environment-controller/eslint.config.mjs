import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import { baseConfig, prettierConfig } from '../../eslint.base.mjs';

/**
 * Ways to load code that the dependency graph cannot see, banned so nothing reaches
 * node:child_process past the spawn boundary.
 */
const LOADER_PROPERTIES = '/^(binding|_linkedBinding|dlopen|getBuiltinModule)$/';

const HIDDEN_LOADING_RULES = {
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ImportExpression[source.type!="Literal"]',
      message:
        'import() takes a literal module name in the environment controller (the gate must see it).',
    },
    {
      selector: 'CallExpression[callee.name="require"]',
      message: 'No require() in the environment controller: use a static import the gate can see.',
    },
    {
      selector: 'Identifier[name="createRequire"]',
      message:
        'No createRequire in the environment controller: it loads modules the gate cannot see.',
    },
    // The process loader properties, on any object (globalThis.process, an alias), dotted or
    // as a string key.
    {
      selector: `MemberExpression[property.name=${LOADER_PROPERTIES}]`,
      message: 'process loader properties are not allowed in the environment controller.',
    },
    {
      selector: `MemberExpression[property.value=${LOADER_PROPERTIES}]`,
      message: 'process loader properties are not allowed in the environment controller.',
    },
    {
      selector: `MemberExpression[property.type="TemplateLiteral"][property.quasis.0.value.raw=${LOADER_PROPERTIES}]`,
      message: 'process loader properties are not allowed in the environment controller.',
    },
    {
      selector: `Property[key.name=${LOADER_PROPERTIES}]`,
      message:
        'process loader properties are not allowed in the environment controller (destructuring).',
    },
    {
      selector: `Property[key.value=${LOADER_PROPERTIES}]`,
      message:
        'process loader properties are not allowed in the environment controller (destructuring).',
    },
    // Reflect reaches any property by a computed name; the controller has no use for it.
    {
      selector: 'Identifier[name="Reflect"]',
      message:
        'Reflect is not allowed in the environment controller (it hides property access from lint).',
    },
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: ['vm', 'node:vm'].map((name) => ({
        name,
        message:
          'node:vm runs code the gate cannot see; not allowed in the environment controller.',
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
