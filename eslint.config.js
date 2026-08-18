import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'docs/site/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // PHI must never reach logs. Structured loggers in packages/core enforce redaction;
          // raw console calls bypass that, so they are banned outside of scripts.
          selector: "MemberExpression[object.name='console'][property.name!='error']",
          message: 'Use the redacting logger from @rehabalpha/core instead of console.*',
        },
      ],
      // `x != null` is exempt: it is the idiomatic single check for null-or-undefined, and PCC
      // payloads distinguish the two inconsistently enough that spelling it out twice at every
      // optional field costs clarity without buying anything.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
    },
  },
  {
    files: ['scripts/**/*.{ts,mjs,js}', '**/*.config.{ts,mjs,js}', 'docs/**'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/tests/**'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
