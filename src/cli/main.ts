#!/usr/bin/env node
import { run } from "./commands.js";

// The `minns` command. Everything it does is a bearer request to the control
// plane's /control routes with a personal API token (Account > API tokens).

run(process.argv.slice(2), {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  env: process.env,
}).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  },
);
