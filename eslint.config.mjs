import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.yarn/**', '.pnp.*', '.zcode/**'] },
  ...tseslint.configs.recommended,
)
