//! Stereo parametric EQ.
//!
//! ```text
//! parametric-eq input.wav output.wav --eq @preset.json
//! parametric-eq input.wav output.wav --eq '{"left":[...],"right":[...],"linear_phase":true}'
//! ```

#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use clap::Parser;
use parametric_eq::{
    apply_linear_phase, apply_minimum_phase, apply_preamp, design_bands, design_linear_phase,
    load_preset, peak_abs, read_wav, write_wav, Audio, Biquad, Designed, FilterType,
    LinearPhaseKernel, OutFormat, Preset,
};
use rayon::prelude::*;

#[derive(Parser, Debug)]
#[command(
    name = "parametric-eq",
    version,
    about = "Parametric EQ for WAV files. Left and right are filtered separately.",
    long_about = "High-quality parametric EQ.\n\n\
Gain is in dB. Q uses the Audio EQ Cookbook / Web Audio definition \
(Q ≈ 0.707 is the standard gentle shelf).\n\n\
The signal path is 64-bit floating point. Linear phase is a zero-phase FIR \
matched to the biquad magnitude, with the group delay removed so the output \
stays sample-aligned. Default output is 64-bit float WAV."
)]
struct Args {
    /// Input WAV (pcm 16/24/32 or float 32/64).
    input: PathBuf,

    /// Output WAV.
    output: PathBuf,

    /// EQ JSON string, @path/to/preset.json, or a path to a JSON file.
    #[arg(short = 'e', long = "eq")]
    eq: String,

    /// Output sample format: f64 (default), f32, i24, or i16.
    /// Integer formats use TPDF dither and first-order noise shaping.
    #[arg(long, default_value = "f64")]
    format: String,
}

fn main() -> ExitCode {
    if let Err(err) = run() {
        eprintln!("error: {err:#}");
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn run() -> Result<()> {
    let args = Args::parse();
    let format = OutFormat::parse(&args.format).with_context(|| {
        format!(
            "unknown --format '{}' (expected f64, f32, i24, or i16)",
            args.format
        )
    })?;
    let preset = load_preset(&args.eq)?;
    let audio = read_wav(&args.input)?;
    if audio.channel_count() == 0 || audio.frames() == 0 {
        bail!("input WAV has no samples");
    }
    if audio.channel_count() > 2 {
        bail!(
            "input has {} channels; this tool processes mono and stereo only",
            audio.channel_count()
        );
    }

    let started = Instant::now();
    let rendered = render(&audio, &preset)?;
    let elapsed = started.elapsed();

    let in_peak = audio
        .channels
        .par_iter()
        .map(|ch| peak_abs(ch))
        .reduce(|| 0.0, f64::max);
    let out_peak = rendered
        .channels
        .par_iter()
        .map(|ch| peak_abs(ch))
        .reduce(|| 0.0, f64::max);

    write_wav(&args.output, audio.sample_rate, &rendered.channels, format)?;
    report(
        &args, &audio, &preset, &rendered, format, in_peak, out_peak, elapsed,
    );
    Ok(())
}

struct Rendered {
    channels: Vec<Vec<f64>>,
    left: Designed,
    right: Designed,
    linear: bool,
    kernel_len: usize,
    kernel_truncated: bool,
    delay_samples: usize,
}

fn render(audio: &Audio, preset: &Preset) -> Result<Rendered> {
    let sr = audio.sample_rate as f64;
    warn_allpass("left", &preset.left, preset.linear_phase);
    if audio.channel_count() == 1 {
        if let Some(right) = &preset.right {
            if right != &preset.left {
                eprintln!(
                    "warning: mono input; the right curve is ignored and the left curve is applied"
                );
            }
        }
    } else {
        warn_allpass("right", preset.right_bands(), preset.linear_phase);
    }

    let left = design_bands("left", &preset.left, sr)?;
    let right = if audio.channel_count() == 1 || preset.right_bands() == preset.left.as_slice() {
        left.clone()
    } else {
        design_bands("right", preset.right_bands(), sr)?
    };

    let (channels, kernel_len, kernel_truncated, delay_samples) = if preset.linear_phase {
        let (kern_l, kern_r) = if left.biquads == right.biquads {
            let kern = design_linear_phase(&left.biquads);
            (kern.clone(), kern)
        } else {
            rayon::join(
                || design_linear_phase(&left.biquads),
                || design_linear_phase(&right.biquads),
            )
        };
        let channels = apply_kernels(&audio.channels, &kern_l, &kern_r);
        let truncated = kern_l.truncated || kern_r.truncated;
        let delay = kern_l.delay_samples.max(kern_r.delay_samples);
        let len = kern_l.impulse.len().max(kern_r.impulse.len());
        (channels, len, truncated, delay)
    } else {
        let channels = apply_minimum(&audio.channels, &left, &right);
        (channels, 0, false, 0)
    };
    let mut channels = channels;
    apply_preamp(&mut channels, preset.preamp_left, preset.preamp_right_db());

    Ok(Rendered {
        channels,
        left,
        right,
        linear: preset.linear_phase,
        kernel_len,
        kernel_truncated,
        delay_samples,
    })
}

fn apply_kernels(
    channels: &[Vec<f64>],
    left: &LinearPhaseKernel,
    right: &LinearPhaseKernel,
) -> Vec<Vec<f64>> {
    match channels {
        [mono] => vec![apply_linear_phase(mono, left)],
        [l, r] => {
            let (ol, or) = rayon::join(
                || apply_linear_phase(l, left),
                || apply_linear_phase(r, right),
            );
            vec![ol, or]
        }
        _ => unreachable!("channel count is checked before render"),
    }
}

fn apply_minimum(channels: &[Vec<f64>], left: &Designed, right: &Designed) -> Vec<Vec<f64>> {
    match channels {
        [mono] => vec![apply_minimum_phase(mono, &left.biquads)],
        [l, r] => {
            let (ol, or) = rayon::join(
                || apply_minimum_phase(l, &left.biquads),
                || apply_minimum_phase(r, &right.biquads),
            );
            vec![ol, or]
        }
        _ => unreachable!("channel count is checked before render"),
    }
}

fn warn_allpass(channel: &str, bands: &[parametric_eq::Band], linear: bool) {
    if linear && bands.iter().any(|band| band.kind == FilterType::AllPass) {
        eprintln!(
            "warning: {channel} allpass bands are magnitude-transparent, so linear-phase mode does not apply them"
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn report(
    args: &Args,
    audio: &Audio,
    preset: &Preset,
    rendered: &Rendered,
    format: OutFormat,
    in_peak: f64,
    out_peak: f64,
    elapsed: std::time::Duration,
) {
    let name = preset.name.as_deref().unwrap_or("(unnamed)");
    let layout = if audio.channel_count() == 1 {
        "mono"
    } else {
        "stereo"
    };
    let seconds = audio.frames() as f64 / audio.sample_rate as f64;
    eprintln!("parametric-eq: {name}");
    eprintln!(
        "  input:   {} Hz, {layout}, {:.3} s, {}, peak {} dBFS",
        audio.sample_rate,
        seconds,
        audio.source_format.label(),
        dbfs(in_peak)
    );
    eprintln!("  threads: {}", rayon::current_num_threads());
    if rendered.linear {
        let secs = rendered.kernel_len as f64 / audio.sample_rate as f64;
        eprintln!(
            "  mode:    linear phase, FIR {} taps ({secs:.3} s), delay of {} samples removed",
            rendered.kernel_len, rendered.delay_samples
        );
        if rendered.kernel_truncated {
            eprintln!(
                "  warning: FIR was capped and Kaiser-windowed; the magnitude match is still very close"
            );
        }
    } else {
        eprintln!("  mode:    minimum phase (cascaded biquads)");
    }
    eprintln!(
        "  preamp:  left {:.1} dB, right {:.1} dB",
        preset.preamp_left,
        preset.preamp_right_db()
    );
    print_curve("left", &rendered.left);
    if audio.channel_count() == 2 {
        print_curve("right", &rendered.right);
    }
    eprintln!(
        "  output:  {}, peak {} dBFS, wrote {} in {:.2?}",
        format.label(),
        dbfs(out_peak),
        args.output.display(),
        elapsed
    );
    if out_peak > 1.0 {
        eprintln!(
            "  warning: output peak is above 0 dBFS ({})",
            dbfs(out_peak)
        );
        if matches!(format, OutFormat::I16 | OutFormat::I24) {
            eprintln!("  warning: integer output was clipped to full scale");
        } else {
            eprintln!("  note: float WAV keeps the overs; no clip was applied");
        }
    }
}

fn print_curve(name: &str, designed: &Designed) {
    if designed.biquads.is_empty() {
        eprintln!(
            "  {name:<5}  bypass ({} unity band{} skipped)",
            designed.skipped_unity,
            if designed.skipped_unity == 1 { "" } else { "s" }
        );
        return;
    }
    for band in &designed.biquads {
        eprintln!("  {name:<5}  {}", format_band(band));
    }
    if designed.skipped_unity > 0 {
        eprintln!(
            "         ({} unity band{} skipped)",
            designed.skipped_unity,
            if designed.skipped_unity == 1 { "" } else { "s" }
        );
    }
}

fn format_band(band: &Biquad) -> String {
    let gain = if band.kind.gain_is_meaningful() {
        format!("{:+7.2} dB", band.gain_db)
    } else {
        "        ".to_string()
    };
    format!(
        "{:<9} {:>10.2} Hz  {gain}  Q={:<7.3}",
        band.kind.label(),
        band.freq,
        band.q
    )
}

fn dbfs(peak: f64) -> String {
    if peak <= 0.0 || !peak.is_finite() {
        "-inf".to_string()
    } else {
        format!("{:.2}", 20.0 * peak.log10())
    }
}
