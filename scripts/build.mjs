import { buildSync } from "esbuild";
import { copyFileSync, mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "index.js");
const tmpfile = join(root, "dist", "index.js.tmp");

mkdirSync(join(root, "dist"), { recursive: true });
rmSync(tmpfile, { force: true });

try {
  buildSync({
    entryPoints: [join(root, "src", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: tmpfile,
    external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
  });
} catch (err) {
  console.error(err);
  rmSync(tmpfile, { force: true });
  process.exit(1);
}

try {
  renameSync(tmpfile, outfile);
} catch (err) {
  // Windows may return EXDEV/EPERM when the target is open or on certain FS setups.
  // Fall back to copy+unlink so readers still see a complete file after the write.
  copyFileSync(tmpfile, outfile);
  unlinkSync(tmpfile);
}
