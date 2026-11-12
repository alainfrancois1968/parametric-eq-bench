//! WAV read/write.
//!
//! Reading goes through `hound` for PCM 16/24/32 and float 32, including
//! WAVEFORMATEXTENSIBLE files. Float 64 is read and written directly because
//! hound does not support it. Integer output is TPDF-dithered with first-order
//! noise shaping, independently per channel.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use anyhow::{bail, Context, Result};
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use rayon::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat {
    Int { bits: u16 },
    Float { bits: u16 },
}

impl SourceFormat {
    pub fn label(self) -> String {
        match self {
            Self::Int { bits } => format!("{bits}-bit pcm"),
            Self::Float { bits } => format!("{bits}-bit float"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutFormat {
    F32,
    F64,
    I24,
    I16,
}

impl OutFormat {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "f32" | "float" | "float32" | "32" => Some(Self::F32),
            "f64" | "float64" | "64" => Some(Self::F64),
            "i24" | "24" | "pcm24" => Some(Self::I24),
            "i16" | "16" | "pcm16" => Some(Self::I16),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::F32 => "32-bit float",
            Self::F64 => "64-bit float",
            Self::I24 => "24-bit pcm",
            Self::I16 => "16-bit pcm",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Audio {
    pub sample_rate: u32,
    pub channels: Vec<Vec<f64>>,
    pub source_format: SourceFormat,
}

impl Audio {
    pub fn frames(&self) -> usize {
        self.channels.first().map(|c| c.len()).unwrap_or(0)
    }

    pub fn channel_count(&self) -> usize {
        self.channels.len()
    }
}

pub fn read_wav(path: &Path) -> Result<Audio> {
    if probe_f64(path)? {
        return read_f64(path);
    }
    read_hound(path)
}

fn read_hound(path: &Path) -> Result<Audio> {
    let mut reader =
        WavReader::open(path).with_context(|| format!("failed to open WAV {}", path.display()))?;
    let spec = reader.spec();
    if spec.channels == 0 {
        bail!("WAV has zero channels");
    }
    if spec.sample_rate == 0 {
        bail!("WAV sample rate is 0");
    }
    let channels_n = spec.channels as usize;
    let frames = reader.duration() as usize;
    let mut channels = vec![Vec::with_capacity(frames); channels_n];
    let source_format = match (spec.sample_format, spec.bits_per_sample) {
        (SampleFormat::Float, 32) => {
            push_planar(&mut channels, channels_n, reader.samples::<f32>(), |s| {
                s as f64
            })?;
            SourceFormat::Float { bits: 32 }
        }
        (SampleFormat::Int, 16) => {
            push_planar(&mut channels, channels_n, reader.samples::<i16>(), |s| {
                s as f64 / 32768.0
            })?;
            SourceFormat::Int { bits: 16 }
        }
        (SampleFormat::Int, 24) => {
            push_planar(&mut channels, channels_n, reader.samples::<i32>(), |s| {
                s as f64 / 8_388_608.0
            })?;
            SourceFormat::Int { bits: 24 }
        }
        (SampleFormat::Int, 32) => {
            push_planar(&mut channels, channels_n, reader.samples::<i32>(), |s| {
                s as f64 / 2_147_483_648.0
            })?;
            SourceFormat::Int { bits: 32 }
        }
        (format, bits) => {
            bail!("unsupported WAV format {format:?} / {bits} bits (supported: pcm 16/24/32, float 32/64)")
        }
    };
    for channel in &channels {
        if channel.iter().any(|s| !s.is_finite()) {
            bail!("input contains a non-finite sample");
        }
    }
    Ok(Audio {
        sample_rate: spec.sample_rate,
        channels,
        source_format,
    })
}

fn push_planar<S, I, F>(
    channels: &mut [Vec<f64>],
    channels_n: usize,
    iter: I,
    convert: F,
) -> Result<()>
where
    I: Iterator<Item = Result<S, hound::Error>>,
    F: Fn(S) -> f64,
{
    for (i, sample) in iter.enumerate() {
        let sample = sample.with_context(|| format!("failed to read sample {i}"))?;
        channels[i % channels_n].push(convert(sample));
    }
    let n = channels[0].len();
    if channels.iter().any(|c| c.len() != n) {
        bail!("WAV channel lengths differ");
    }
    Ok(())
}

pub fn write_wav(
    path: &Path,
    sample_rate: u32,
    channels: &[Vec<f64>],
    format: OutFormat,
) -> Result<()> {
    if channels.is_empty() {
        bail!("no channels to write");
    }
    let frames = channels[0].len();
    if channels.iter().any(|c| c.len() != frames) {
        bail!("channel length mismatch while writing");
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
    }
    let tmp = temp_alongside(path);
    let write_result = match format {
        OutFormat::F64 => write_f64(&tmp, sample_rate, channels),
        OutFormat::F32 => write_f32(&tmp, sample_rate, channels),
        OutFormat::I24 => write_pcm(&tmp, sample_rate, channels, 24, 8_388_608.0),
        OutFormat::I16 => write_pcm(&tmp, sample_rate, channels, 16, 32_768.0),
    };
    if let Err(err) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    atomic_publish(&tmp, path)
}

fn temp_alongside(path: &Path) -> std::path::PathBuf {
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(".partial");
    path.with_file_name(name)
}

fn atomic_publish(tmp: &Path, dest: &Path) -> Result<()> {
    match std::fs::rename(tmp, dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(tmp, dest)
                .with_context(|| format!("failed to write {}", dest.display()))?;
            let _ = std::fs::remove_file(tmp);
            Ok(())
        }
    }
}

fn write_f32(path: &Path, sample_rate: u32, channels: &[Vec<f64>]) -> Result<()> {
    let planar: Vec<Vec<f32>> = channels
        .par_iter()
        .map(|ch| ch.iter().map(|&s| s as f32).collect())
        .collect();
    let spec = WavSpec {
        channels: channels.len() as u16,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut writer = WavWriter::create(path, spec)
        .with_context(|| format!("failed to create {}", path.display()))?;
    let frames = planar[0].len();
    for i in 0..frames {
        for channel in &planar {
            writer
                .write_sample(channel[i])
                .context("failed to write sample")?;
        }
    }
    writer.finalize().context("failed to finalize WAV")?;
    Ok(())
}

fn write_pcm(
    path: &Path,
    sample_rate: u32,
    channels: &[Vec<f64>],
    bits: u16,
    scale: f64,
) -> Result<()> {
    let planar: Vec<Vec<i32>> = channels
        .par_iter()
        .enumerate()
        .map(|(ch, samples)| quantize_channel(samples, scale, channel_seed(ch)))
        .collect();
    let spec = WavSpec {
        channels: channels.len() as u16,
        sample_rate,
        bits_per_sample: bits,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec)
        .with_context(|| format!("failed to create {}", path.display()))?;
    let frames = planar[0].len();
    for i in 0..frames {
        for channel in &planar {
            let sample = channel[i];
            if bits == 16 {
                writer
                    .write_sample(sample as i16)
                    .context("failed to write sample")?;
            } else {
                writer
                    .write_sample(sample)
                    .context("failed to write sample")?;
            }
        }
    }
    writer.finalize().context("failed to finalize WAV")?;
    Ok(())
}

/// TPDF dither (±1 LSB) plus first-order error feedback.
/// Deterministic per channel so repeated renders match.
fn quantize_channel(samples: &[f64], scale: f64, seed: u64) -> Vec<i32> {
    let mut rng = Rng(seed);
    let mut err = 0.0;
    let lsb = 1.0 / scale;
    let min_q = -scale;
    let max_q = scale - 1.0;
    let mut out = Vec::with_capacity(samples.len());
    for &sample in samples {
        let shaped = sample + err;
        let dither = (rng.next_unit() - rng.next_unit()) * lsb;
        let mut q = ((shaped + dither) * scale).round();
        if q < min_q {
            q = min_q;
        } else if q > max_q {
            q = max_q;
        }
        let reconstructed = q / scale;
        err = shaped - reconstructed;
        // Keep the shaper from running away if a NaN ever slipped through.
        if !err.is_finite() {
            err = 0.0;
        }
        out.push(q as i32);
    }
    out
}

fn channel_seed(channel: usize) -> u64 {
    0xA5A5_1234_C0FF_EE01 ^ (channel as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = if x == 0 { 0x1234_5678_9ABC_DEF0 } else { x };
        self.0
    }

    /// (0, 1)
    fn next_unit(&mut self) -> f64 {
        let bits = self.next_u64() >> 11;
        bits as f64 / ((1u64 << 53) as f64)
    }
}

fn write_f64(path: &Path, sample_rate: u32, channels: &[Vec<f64>]) -> Result<()> {
    let frames = channels[0].len();
    let ch = channels.len();
    let data_bytes = frames
        .checked_mul(ch)
        .and_then(|n| n.checked_mul(8))
        .context("output is too large")?;
    if data_bytes > (u32::MAX as usize).saturating_sub(64) {
        bail!("output exceeds the classic 4 GB WAV limit; split the file");
    }
    let mut file = BufWriter::with_capacity(
        1 << 20,
        File::create(path).with_context(|| format!("failed to create {}", path.display()))?,
    );
    file.write_all(b"RIFF")?;
    file.write_all(&((36 + data_bytes) as u32).to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&3u16.to_le_bytes())?; // IEEE float
    file.write_all(&(ch as u16).to_le_bytes())?;
    file.write_all(&sample_rate.to_le_bytes())?;
    let block = (ch * 8) as u32;
    file.write_all(&(sample_rate.saturating_mul(block)).to_le_bytes())?;
    file.write_all(&(block as u16).to_le_bytes())?;
    file.write_all(&64u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&(data_bytes as u32).to_le_bytes())?;

    let mut buf = vec![0u8; ch * 8 * 4096.min(frames.max(1))];
    let mut frame = 0;
    while frame < frames {
        let n = (frames - frame).min(4096);
        let bytes = n * ch * 8;
        let slice = &mut buf[..bytes];
        for i in 0..n {
            for (c, channel) in channels.iter().enumerate() {
                let offset = (i * ch + c) * 8;
                slice[offset..offset + 8].copy_from_slice(&channel[frame + i].to_le_bytes());
            }
        }
        file.write_all(slice)?;
        frame += n;
    }
    file.flush()?;
    Ok(())
}

fn probe_f64(path: &Path) -> Result<bool> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut header = [0u8; 12];
    if file.read_exact(&mut header).is_err() {
        return Ok(false);
    }
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Ok(false);
    }
    loop {
        let mut chunk = [0u8; 8];
        if file.read_exact(&mut chunk).is_err() {
            return Ok(false);
        }
        let size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
        if &chunk[0..4] == b"fmt " {
            if size > 1024 {
                return Ok(false);
            }
            let mut fmt = vec![0u8; size as usize];
            if file.read_exact(&mut fmt).is_err() {
                return Ok(false);
            }
            return Ok(fmt_is_f64(&fmt));
        }
        if file.seek(SeekFrom::Current(size as i64)).is_err() {
            return Ok(false);
        }
        if size % 2 == 1 {
            let _ = file.seek(SeekFrom::Current(1));
        }
    }
}

fn fmt_is_f64(fmt: &[u8]) -> bool {
    if fmt.len() < 16 {
        return false;
    }
    let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
    let bits = u16::from_le_bytes([fmt[14], fmt[15]]);
    if tag == 3 && bits == 64 {
        return true;
    }
    // WAVEFORMATEXTENSIBLE
    if tag == 0xFFFE && fmt.len() >= 40 && bits == 64 {
        let guid = &fmt[24..40];
        const FLOAT_GUID: [u8; 16] = [
            0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38,
            0x9b, 0x71,
        ];
        return guid == FLOAT_GUID;
    }
    false
}

fn read_f64(path: &Path) -> Result<Audio> {
    let file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut header = [0u8; 12];
    reader.read_exact(&mut header)?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        bail!("not a RIFF WAVE file");
    }
    let mut sample_rate = 0u32;
    let mut channels_n = 0usize;
    let mut data: Option<Vec<u8>> = None;
    loop {
        let mut chunk = [0u8; 8];
        if reader.read_exact(&mut chunk).is_err() {
            break;
        }
        let size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as usize;
        if &chunk[0..4] == b"fmt " {
            let mut fmt = vec![0u8; size];
            reader.read_exact(&mut fmt)?;
            if !fmt_is_f64(&fmt) {
                bail!("expected 64-bit float WAV");
            }
            channels_n = u16::from_le_bytes([fmt[2], fmt[3]]) as usize;
            sample_rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
            let block = u16::from_le_bytes([fmt[12], fmt[13]]) as usize;
            if channels_n == 0 || block != channels_n * 8 {
                bail!("64-bit float WAV has an unexpected block align");
            }
        } else if &chunk[0..4] == b"data" {
            let mut buf = vec![0u8; size];
            reader
                .read_exact(&mut buf)
                .context("truncated WAV data chunk")?;
            data = Some(buf);
        } else {
            let mut discard = vec![0u8; size];
            reader.read_exact(&mut discard)?;
        }
        if size % 2 == 1 {
            let mut pad = [0u8; 1];
            let _ = reader.read_exact(&mut pad);
        }
    }
    let data = data.context("WAV is missing a data chunk")?;
    if channels_n == 0 || sample_rate == 0 {
        bail!("WAV fmt chunk is missing or invalid");
    }
    if data.len() % (channels_n * 8) != 0 {
        bail!("64-bit float data chunk is not a whole number of frames");
    }
    let frames = data.len() / (channels_n * 8);
    let mut channels = vec![Vec::with_capacity(frames); channels_n];
    for frame in 0..frames {
        for (ch, channel) in channels.iter_mut().enumerate() {
            let offset = (frame * channels_n + ch) * 8;
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&data[offset..offset + 8]);
            let sample = f64::from_le_bytes(bytes);
            if !sample.is_finite() {
                bail!("input contains a non-finite sample");
            }
            channel.push(sample);
        }
    }
    Ok(Audio {
        sample_rate,
        channels,
        source_format: SourceFormat::Float { bits: 64 },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut path = env::temp_dir();
        path.push(format!("parametric-eq-{name}-{}", std::process::id()));
        path
    }

    #[test]
    fn f64_roundtrip_is_exact() {
        let path = temp_path("f64.wav");
        let channels = vec![
            vec![0.0, -1.0, 0.5, 1.0e-12, -0.125],
            vec![0.25, 0.5, -0.75, 0.125, 1.0],
        ];
        write_wav(&path, 48_000, &channels, OutFormat::F64).unwrap();
        let audio = read_wav(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(audio.sample_rate, 48_000);
        assert_eq!(audio.source_format, SourceFormat::Float { bits: 64 });
        assert_eq!(audio.channels, channels);
    }

    #[test]
    fn f32_roundtrip_preserves_f32_values() {
        let path = temp_path("f32.wav");
        let channels = vec![vec![0.0f64, 0.5, -0.25, 0.125, -1.0]];
        write_wav(&path, 44_100, &channels, OutFormat::F32).unwrap();
        let audio = read_wav(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(audio.source_format, SourceFormat::Float { bits: 32 });
        for (a, b) in audio.channels[0].iter().zip(channels[0].iter()) {
            assert!((a - b).abs() < 1e-7, "{a} vs {b}");
        }
    }

    #[test]
    fn i24_scale_roundtrip_without_going_through_dither_api() {
        let path = temp_path("i24.wav");
        let spec = WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 24,
            sample_format: SampleFormat::Int,
        };
        {
            let mut writer = WavWriter::create(&path, spec).unwrap();
            writer.write_sample(8_388_607_i32).unwrap();
            writer.write_sample(-8_388_608_i32).unwrap();
            writer.write_sample(0_i32).unwrap();
            writer.finalize().unwrap();
        }
        let audio = read_wav(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(audio.source_format, SourceFormat::Int { bits: 24 });
        assert!((audio.channels[0][0] - (8_388_607.0 / 8_388_608.0)).abs() < 1e-12);
        assert!((audio.channels[0][1] + 1.0).abs() < 1e-12);
        assert_eq!(audio.channels[0][2], 0.0);
    }

    #[test]
    fn silence_dither_stays_within_a_couple_of_lsbs() {
        let samples = vec![0.0; 2000];
        let q = quantize_channel(&samples, 32_768.0, channel_seed(0));
        let max = q.iter().map(|s| s.abs()).max().unwrap();
        assert!(max <= 2, "dither peak {max} LSB");
    }
}
