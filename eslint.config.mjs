import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '.yarn/**', '.pnp.*', '.zcode/**'] },
  ...tseslint.configs.recommended,
)
