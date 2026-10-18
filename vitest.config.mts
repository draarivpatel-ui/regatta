import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Gives every test file its own git config, so no unit test sees the real ~/.gitconfig.
    setupFiles: [fileURLToPath(new URL('./test/setup.ts', import.meta.url))]
  }
})
