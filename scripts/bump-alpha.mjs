import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const packages = [
  "packages/collection/package.json",
  "packages/client/package.json",
  "packages/mira/package.json",
  "packages/tanstack-adapter/package.json",
  "packages/dashboard/package.json",
];

function bumpAlpha(version) {
  const match = version.match(/^(\d+\.\d+\.\d+)-alpha\.(\d+)$/);
  if (!match) throw new Error(`Version "${version}" is not an alpha version (expected X.Y.Z-alpha.N)`);
  return `${match[1]}-alpha.${Number(match[2]) + 1}`;
}

const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim();
if (dirty) {
  console.error("Uncommitted changes detected. Commit or stash them before releasing:\n");
  console.error(dirty);
  process.exit(1);
}

let newVersion;

for (const rel of packages) {
  const path = resolve(root, rel);
  const pkg = JSON.parse(readFileSync(path, "utf8"));

  if (!newVersion) {
    newVersion = bumpAlpha(pkg.version);
    console.log(`Bumping alpha: ${pkg.version} → ${newVersion}`);
  }

  pkg.version = newVersion;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  updated ${rel}`);
}

for (const rel of packages) {
  execSync(`git add ${rel}`, { cwd: root });
}
execSync(`git commit -m "chore: release ${newVersion}"`, { cwd: root, stdio: "inherit" });
