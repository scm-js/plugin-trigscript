import { defineConfig } from "vitest/config";

// Most tests here compile a script with the real TypeScript compiler, some a dozen times over: on a slow runner
// one of those passes Vitest's five seconds without anything being wrong (the v3.10.0 tag's first CI run did).
export default defineConfig({ test: { testTimeout: 30_000 } });
