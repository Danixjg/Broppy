import { spawnSync } from "node:child_process";
import { copyFileSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync("cargo", ["build", "--locked", "--release", "-p", "brain-core", "--features", "node"], { cwd: root, stdio: "inherit" });
if (result.error) throw new Error("Cargo is required. Install the toolchain in rust-toolchain.toml with rustup.", { cause: result.error });
if (result.status !== 0) process.exit(result.status ?? 1);
const library = process.platform === "win32" ? "brain_core.dll"
  : process.platform === "darwin" ? "libbrain_core.dylib" : "libbrain_core.so";
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
const output = join(root, "packages/rust-core/brain-core.node");
const temporary = `${output}.${process.pid}.tmp`;
try {
  copyFileSync(join(target, "release", library), temporary);
  renameSync(temporary, output);
} finally {
  rmSync(temporary, { force: true });
}
console.log("Built packages/rust-core/brain-core.node");
