/**
 * Rewrite relative `.ts` module specifiers to `.js` inside emitted `dist`
 * declaration files. `rewriteRelativeImportExtensions` only rewrites JS emit;
 * declarations keep source specifiers, which breaks TS consumers that resolve
 * the published `.d.ts` chain without `allowImportingTsExtensions`.
 */
import fs from "node:fs/promises";
import path from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
const SPECIFIER = /((?:from|import\()\s*")(\.[^"]*)\.ts(")/g;

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".d.ts")) yield full;
  }
}

let rewritten = 0;
for await (const file of walk(DIST)) {
  const source = await fs.readFile(file, "utf8");
  const updated = source.replace(SPECIFIER, "$1$2.js$3");
  if (updated !== source) {
    await fs.writeFile(file, updated);
    rewritten += 1;
  }
}
console.log(`rewrite-dts-extensions: rewrote specifiers in ${rewritten} declaration file(s)`);
