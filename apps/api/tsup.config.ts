import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  noExternal: ['@gate/contracts'],
  clean: true,
  sourcemap: true,
});
