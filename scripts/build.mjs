import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "index.js");
const tmpfile = join(root, "dist", "index.js.tmp");
const esbuild = join(root, "node_modules", "esbuild", "bin", "esbuild");

mkdirSync(join(root, "dist"), { recursive: true });
rmSync(tmpfile, { force: true });

const result = spawnSync(
  process.execPath,
  [
    esbuild,
    join(root, "src", "index.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${tmpfile}`,
    "--external:@earendil-works/pi-ai",
    "--external:@earendil-works/pi-coding-agent",
  ],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  rmSync(tmpfile, { force: true });
  process.exit(result.status ?? 1);
}

try {
  renameSync(tmpfile, outfile);
} catch (err) {
  // Windows may return EXDEV/EPERM when the target is open or on certain FS setups.
  // Fall back to copy+unlink so readers still see a complete file after the write.
  copyFileSync(tmpfile, outfile);
  unlinkSync(tmpfile);
}
