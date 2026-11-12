# Parametric EQ bench 1.0.18


Web page for the parametric-eq command-line tool. The page header shows "bench 1.0.18".
Each channel has a preamp in dB, applied after the filters. Suggest sets it to the
negative of the curve's highest point. The CLI is crates/parametric-eq 1.1.0:
cargo build --release --manifest-path crates/parametric-eq/Cargo.toml
Put that binary on PATH as parametric-eq.

Filter design and the drawn curve come from the parametric-eq library
(https://github.com/alainfrancois1968/parametric-eq). Do not clone that repository into this folder.

## Run

Install Node.js 22 (https://nodejs.org/) and Rust (https://rustup.rs/).

Install the CLI from this folder, so the preamp fields are applied:

```bash
cargo install --path crates/parametric-eq
```

Then, in this folder:

```bash
npm install
npm run dev
```

Open http://localhost:8080/

`~/.cargo/bin` must be on your PATH. Rustup adds it. The page finds `parametric-eq` there.

If the binary is somewhere else:

```bash
PARAMETRIC_EQ_BIN="/absolute/path/to/parametric-eq" npm run dev
```
