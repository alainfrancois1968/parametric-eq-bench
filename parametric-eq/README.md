# parametric-eq

Command-line parametric EQ for WAV files. Left and right are filtered
separately. The signal path is 64-bit floating point.

```
parametric-eq input.wav output.wav --eq @preset.json
parametric-eq input.wav output.wav --eq '{"name":"bass","linear_phase":true,"left":[...],"right":[...]}'
```

Parallelism is [Rayon](https://github.com/rayon-rs/rayon): the two channels run
together, linear-phase FFT blocks run together, and the frequency-response
grid is filled in parallel.

## Build

```
cargo build --release
./target/release/parametric-eq --help
```

The release profile enables fat LTO. `.cargo/config.toml` sets
`-C target-cpu=native` so `rustfft` uses this machine's SIMD. Delete that flag
if you need a portable binary.

## Preset JSON

`gain` is **decibels**. `q` is the Audio EQ Cookbook / Web Audio Q. For shelves,
`Q ≈ 0.707` is the standard gentle slope (the steepest shelf that stays
monotonic). `linear_phase` selects the FIR path. `name` is only a label.
If `right` is omitted, the left curve is copied. An empty `right` array
bypasses the right channel.

```json
{
  "name": "Slightly boost bass",
  "linear_phase": true,
  "left": [
    { "freq": 80, "gain": 2.0, "q": 0.7, "type": "lowshelf" },
    { "freq": 250, "gain": 0.5, "q": 1.0, "type": "peak" }
  ],
  "right": [
    { "freq": 80, "gain": 2.0, "q": 0.7, "type": "lowshelf" },
    { "freq": 250, "gain": 0.5, "q": 1.0, "type": "peak" }
  ]
}
```

A full copy of that preset is in `examples/slightly_boost_bass.json`.
Bands whose gain is exactly 0 dB (peak / shelf) are skipped.

Filter `type` values, case-insensitive, hyphens and spaces ignored:

| type | effect |
|---|---|
| `peak` | peaking EQ, gain in dB at `freq` |
| `lowshelf` | low shelf, gain in dB below `freq` |
| `highshelf` | high shelf, gain in dB above `freq` |
| `lowpass` | low pass, `gain` ignored, Q = 0.707 is Butterworth |
| `highpass` | high pass, `gain` ignored |
| `notch` | notch at `freq` |
| `bandpass` | band pass, 0 dB at `freq` |
| `allpass` | allpass. Ignored in linear-phase mode (magnitude is 1) |

Bands are cascaded in the order written. Frequency must sit strictly inside
`(0, sample_rate / 2)`.

## Processing

**Minimum phase** (`"linear_phase": false`) cascades double-precision RBJ
biquads (transposed direct form II). A preset that does nothing is a
bit-exact copy.

**Linear phase** (`"linear_phase": true`) samples the cascade magnitude on a
long FFT grid and builds a linear-phase FIR. The constant group delay is
removed, so the output has the **same length** as the input and stays
sample-aligned (zero phase). The FIR is long enough that the slowest pole's
tail is below about −300 dB, capped at 2^20 taps. If the cap is hit the
impulse is Kaiser-windowed (β = 20) and a warning is printed.

Mono files use the left curve. More than two channels is rejected.

## Output

The default output is **64-bit float WAV**, which keeps the full internal
path. No peak normalization and no clipping is applied to float output.

```
--format f64    64-bit float (default)
--format f32    32-bit float, the usual DAW interchange format
--format i24    24-bit PCM, TPDF dither, first-order noise shaping
--format i16    16-bit PCM, TPDF dither, first-order noise shaping
```

Input can be PCM 16/24/32 or float 32/64, including WAVEFORMATEXTENSIBLE
files that `hound` understands. Overs above 0 dBFS are reported on stderr.
Classic WAV is limited to 4 GB.

## Quality notes

- Coefficients and the sample path are `f64`.
- Shelf and peaking formulas are the Robert Bristow-Johnson cookbook, the same
  ones used by the Web Audio `BiquadFilter`.
- Linear phase matches that magnitude response. It does not use forward-backward
  IIR (`filtfilt`), which would square the response shape.
- Integer renders dither with a fixed per-channel seed, so the same command
  writes the same file.
- Denormal biquad states are flushed so silence does not stall the CPU.

## Library

`src/lib.rs` exposes preset parsing, biquad design, both processors, and WAV
I/O if you want to call this from other Rust code.
