import { defineConfig } from 'vitest/config';

// Plain Node tests of the app's JSON files; nothing here talks to Make or to Link To Card.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
