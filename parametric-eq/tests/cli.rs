use std::process::Command;

use parametric_eq::{read_wav, write_wav, OutFormat};

#[test]
fn cli_linear_phase_boosts_left_and_cuts_right() {
    let dir = std::env::temp_dir().join(format!("peq-cli-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("in.wav");
    let output = dir.join("out.wav");
    let sr = 48_000u32;
    let n = sr as usize;
    let freq = 1_000.0;
    let left: Vec<f64> = (0..n)
        .map(|i| (std::f64::consts::TAU * freq * i as f64 / sr as f64).cos() * 0.2)
        .collect();
    let right = left.clone();
    write_wav(&input, sr, &[left.clone(), right.clone()], OutFormat::F32).unwrap();

    let preset = r#"{
        "name": "cli",
        "linear_phase": true,
        "left": [{"freq": 1000, "gain": 6.0, "q": 1.0, "type": "peak"}],
        "right": [{"freq": 1000, "gain": -6.0, "q": 1.0, "type": "peak"}]
    }"#;
    let bin = binary();
    let status = Command::new(bin)
        .arg(&input)
        .arg(&output)
        .arg("--eq")
        .arg(preset)
        .arg("--format")
        .arg("f32")
        .status()
        .expect("run binary");
    assert!(status.success(), "cli failed");

    let audio = read_wav(&output).unwrap();
    assert_eq!(audio.sample_rate, sr);
    assert_eq!(audio.channel_count(), 2);
    assert_eq!(audio.frames(), n);

    let mid = n / 4..3 * n / 4;
    let ratio_l = rms(&audio.channels[0][mid.clone()]) / rms(&left[mid.clone()]);
    let ratio_r = rms(&audio.channels[1][mid.clone()]) / rms(&right[mid]);
    assert!(ratio_l > 1.9 && ratio_l < 2.1, "left ratio {ratio_l}");
    assert!(ratio_r > 0.45 && ratio_r < 0.55, "right ratio {ratio_r}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cli_reads_example_preset_file() {
    let dir = std::env::temp_dir().join(format!("peq-cli-example-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("in.wav");
    let output = dir.join("out.wav");
    // Short file: this checks that the shipped preset parses and the process
    // finishes. Accuracy of this curve is covered by the library tests.
    let sr = 48_000u32;
    let n = 4_096usize;
    let tone: Vec<f64> = (0..n)
        .map(|i| (std::f64::consts::TAU * 80.0 * i as f64 / sr as f64).cos() * 0.2)
        .collect();
    write_wav(&input, sr, &[tone.clone(), tone], OutFormat::F64).unwrap();

    let preset = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/examples/slightly_boost_bass.json"
    );
    let bin = binary();
    let status = Command::new(bin)
        .arg(&input)
        .arg(&output)
        .arg("--eq")
        .arg(preset)
        .status()
        .expect("run binary");
    assert!(status.success(), "example preset failed");
    let audio = read_wav(&output).unwrap();
    assert_eq!(audio.frames(), n);
    assert_eq!(audio.channel_count(), 2);
    assert!(audio.channels[0].iter().all(|s| s.is_finite()));
    let _ = std::fs::remove_dir_all(&dir);
}

fn binary() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("CARGO_BIN_EXE_parametric_eq") {
        if !path.is_empty() {
            return std::path::PathBuf::from(path);
        }
    }
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let target = std::env::var("CARGO_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| manifest.join("target"));
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    target.join(profile).join("parametric-eq")
}

fn rms(x: &[f64]) -> f64 {
    (x.iter().map(|s| s * s).sum::<f64>() / x.len() as f64).sqrt()
}
