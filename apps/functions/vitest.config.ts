import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Emulator tests run Firestore transactions that retry under contention; on a busy CI
    // runner the 5 s default turns that into flaky timeouts.
    testTimeout: process.env.FIRESTORE_EMULATOR_HOST ? 20_000 : 5_000,
  },
});
