#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v cargo >/dev/null 2>&1; then
  task_toolchain="$(mktemp -d "${TMPDIR:-/tmp}/broppy-rust.XXXXXX")"
  export CARGO_HOME="$task_toolchain/cargo"
  export RUSTUP_HOME="$task_toolchain/rustup"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location https://sh.rustup.rs --output "$task_toolchain/rustup-init.sh"
  sh "$task_toolchain/rustup-init.sh" -y --profile minimal --no-modify-path --default-toolchain none
  export PATH="$CARGO_HOME/bin:$PATH"
fi
cd "$task_root"
node scripts/build-rust.mjs
