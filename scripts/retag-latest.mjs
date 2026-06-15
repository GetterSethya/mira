import { readFileSync } from "fs";
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

for (const rel of packages) {
  const pkg = JSON.parse(readFileSync(resolve(root, rel), "utf8"));
  const spec = `${pkg.name}@${pkg.version}`;
  console.log(`npm dist-tag add ${spec} latest`);
  execSync(`npm dist-tag add ${spec} latest`, { cwd: root, stdio: "inherit" });
}
