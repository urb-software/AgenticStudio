// Shared ESLint flat config for all workspace apps.
// Each app composes it in its own eslint.config.mjs with framework-specific rules.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export const baseConfig = [js.configs.recommended, ...tseslint.configs.recommended];

// Keep last: turns off stylistic rules that conflict with Prettier.
export const prettierConfig = prettier;
