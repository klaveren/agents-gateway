import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/*.Schema.ts']
  },
  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': 'off',
      'no-debugger': 'off',
      'comma-dangle': 'off',
      '@typescript-eslint/comma-dangle': 'off',
      'generator-star-spacing': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
      'no-multi-spaces': ['error'],
    },
  },
);
