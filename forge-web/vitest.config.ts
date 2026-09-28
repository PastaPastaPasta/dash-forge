import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // tsconfig keeps JSX for Next (`preserve`); component tests need it compiled, React 17+ style.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.{ts,tsx}'],
  },
})
