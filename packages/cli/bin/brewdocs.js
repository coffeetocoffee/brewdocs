#!/usr/bin/env node
// Bin shim: register the tsx loader so `npx brewdocs` runs the TS CLI
// without a prebuild step.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
