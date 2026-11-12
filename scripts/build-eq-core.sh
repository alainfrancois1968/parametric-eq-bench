#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root/crates/eq-bridge"
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
wasm="$root/crates/eq-bridge/target/wasm32-unknown-unknown/release/eq_bridge.wasm"
wasm-bindgen --target bundler --out-dir "$root/src/lib/eq-core/bundler" "$wasm"
wasm-bindgen --target nodejs --out-dir "$root/src/lib/eq-core/node" "$wasm"
printf '%s\n' '{ "type": "commonjs" }' > "$root/src/lib/eq-core/node/package.json"
