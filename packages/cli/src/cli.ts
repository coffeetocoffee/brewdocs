#!/usr/bin/env -S npx tsx
import { run } from "./index.js";

run(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
