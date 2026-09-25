import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, relative } from "node:path";

const root = resolve(import.meta.dir, "..");
const build = Bun.spawn([process.execPath, "build", "apps/daemon/src/main.ts", "--compile", "--outfile", "dist/demesned"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await build.exited !== 0) process.exit(1);
const copied = new Set<string>();
const locations: { source: string; target: string }[] = [];
function copyDependency(name: string, require: NodeJS.Require): void {
  if (copied.has(name)) return;
  const metadata = require.resolve(`${name}/package.json`);
  const directory = dirname(metadata);
  const target = join(root, "dist/node_modules", name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(directory, target, { recursive: true, dereference: true });
  copied.add(name);
  locations.push({ source: realpathSync(directory), target });
  const pkg = JSON.parse(readFileSync(metadata, "utf8"));
  const local = createRequire(metadata);
  for (const dependency of Object.keys(pkg.dependencies ?? {})) copyDependency(dependency, local);
  for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
    try { local.resolve(`${dependency}/package.json`); } catch { continue; }
    copyDependency(dependency, local);
  }
}
copyDependency("sharp", createRequire(join(root, "apps/daemon/package.json")));
// Bun standalone's external CJS resolver does not search these package trees
// like its development resolver. Resolve literal package imports at packaging
// time to relocatable relative files; builtins and absent optional backends stay.
for (const location of locations) {
  function rewrite(source: string, target: string): void {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const original = join(source, entry.name), output = join(target, entry.name);
      if (entry.isDirectory()) { rewrite(original, output); continue; }
      if (!/\.(c?js)$/.test(entry.name)) continue;
      const local = createRequire(original);
      const text = readFileSync(original, "utf8").replace(/require\((["'])([^"']+)\1\)/g, (match, _quote, name) => {
        if (name.startsWith(".") || name.startsWith("node:")) return match;
        try {
          const resolved = realpathSync(local.resolve(name));
          const owner = locations.find((item) => resolved.startsWith(item.source + "/"));
          if (!owner) return match;
          const destination = join(owner.target, relative(owner.source, resolved));
          return `require(${JSON.stringify("./" + relative(dirname(output), destination))})`;
        } catch { return match; }
      });
      writeFileSync(output, text);
    }
  }
  rewrite(location.source, location.target);
}
console.log(`Packaged ${copied.size} native image runtime packages in dist/node_modules`);
