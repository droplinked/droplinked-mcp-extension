#!/usr/bin/env node
/**
 * Assemble the bundle directory the .mcpb packs from:
 *
 *   server/index.js        compiled entry point (from dist/)
 *   server/**              the rest of the compiled output
 *   server/node_modules/** production dependencies
 *
 * The manifest's `entry_point` is `server/index.js`, so we stage the
 * compiled output under `server/` and copy the production dependency
 * tree alongside it. Run after `tsc` (the `pack` script chains them).
 */
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(root, "server");
const distDir = join(root, "dist");

if (!existsSync(distDir)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}

// Fresh server/ each run.
rmSync(serverDir, { recursive: true, force: true });
mkdirSync(serverDir, { recursive: true });

// Stage compiled output under server/.
cpSync(distDir, serverDir, { recursive: true });

// Stage a production-only node_modules tree next to the compiled code.
const stageModules = join(serverDir, "node_modules");
console.error("Installing production dependencies into server/ ...");
execSync(
  `npm install --omit=dev --no-audit --no-fund --prefix "${serverDir}" ` +
    `@modelcontextprotocol/sdk zod`,
  { stdio: "inherit", cwd: root },
);

if (!existsSync(stageModules)) {
  console.error("Failed to stage server/node_modules.");
  process.exit(1);
}

// Write a self-describing ESM package.json for the bundled server so
// Node loads the compiled `.js` files as ES modules without a reparse
// warning. Pin the dependency versions actually installed above.
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const serverPkg = {
  name: "droplinked-mcp-extension-server",
  version: rootPkg.version,
  private: true,
  type: "module",
  main: "index.js",
  dependencies: {
    "@modelcontextprotocol/sdk": rootPkg.dependencies["@modelcontextprotocol/sdk"],
    zod: rootPkg.dependencies.zod,
  },
};
writeFileSync(
  join(serverDir, "package.json"),
  JSON.stringify(serverPkg, null, 2) + "\n",
);

console.error("Assembled bundle under server/.");
