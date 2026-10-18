import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Os testes são offline; nada deve depender de rede nem de tempo real.
    testTimeout: 10_000,
  },
});
