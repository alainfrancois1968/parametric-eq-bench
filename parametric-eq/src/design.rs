//! RBJ biquad design (Audio EQ Cookbook / Web Audio formulas).
//!
//! Coefficients are f64, normalized to a0 = 1. Shelves and peaking use
//! `alpha = sin(ω0) / (2Q)`, which is the cookbook's Q parameterization
//! (Q = 1/√2 ≈ 0.707 is the steepest shelf that stays monotonic).

use anyhow::{bail, Result};

use crate::config::{Band, FilterType};

#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
    pub kind: FilterType,
    pub freq: f64,
    pub gain_db: f64,
    pub q: f64,
}

impl PartialEq for Biquad {
    fn eq(&self, other: &Self) -> bool {
        self.b0 == other.b0
            && self.b1 == other.b1
            && self.b2 == other.b2
            && self.a1 == other.a1
            && self.a2 == other.a2
    }
}

impl Biquad {
    /// |H(e^{jω})| of this section.
    pub fn magnitude(&self, omega: f64) -> f64 {
        let (s, c) = omega.sin_cos();
        let z2r = c * c - s * s;
        let z2i = -2.0 * c * s;
        let nr = self.b0 + self.b1 * c + self.b2 * z2r;
        let ni = -self.b1 * s + self.b2 * z2i;
        let dr = 1.0 + self.a1 * c + self.a2 * z2r;
        let di = -self.a1 * s + self.a2 * z2i;
        let d2 = dr * dr + di * di;
        if d2 == 0.0 {
            return f64::INFINITY;
        }
        ((nr * nr + ni * ni) / d2).sqrt()
    }

    /// Radius of the pole closest to the unit circle. Used to size the FIR.
    pub fn pole_radius(&self) -> f64 {
        let disc = self.a1 * self.a1 - 4.0 * self.a2;
        if disc >= 0.0 {
            let s = disc.sqrt();
            let r1 = 0.5 * (-self.a1 + s);
            let r2 = 0.5 * (-self.a1 - s);
            r1.abs().max(r2.abs())
        } else {
            self.a2.abs().sqrt()
        }
    }
}

#[derive(Debug, Clone)]
pub struct Designed {
    pub biquads: Vec<Biquad>,
    pub skipped_unity: usize,
}

/// One-sided impulse tail is designed down to this amplitude before truncation.
const TAIL_AMP: f64 = 1e-15;
const MIN_FIR: usize = 4096;
const MAX_FIR: usize = 1 << 20;
/// Bands closer to 0 dB than this are exactly skipped (peak / shelf only).
const UNITY_GAIN_DB: f64 = 1e-6;

pub fn design_bands(channel: &str, bands: &[Band], sample_rate: f64) -> Result<Designed> {
    if !(sample_rate.is_finite() && sample_rate > 0.0) {
        bail!("invalid sample rate {sample_rate}");
    }
    let nyquist = sample_rate * 0.5;
    let mut biquads = Vec::with_capacity(bands.len());
    let mut skipped_unity = 0usize;

    for (index, band) in bands.iter().enumerate() {
        let n = index + 1;
        if !band.freq.is_finite() || !band.gain.is_finite() || !band.q.is_finite() {
            bail!("{channel} band {n}: freq, gain, and q must be finite");
        }
        if band.freq <= 0.0 || band.freq >= nyquist {
            bail!(
                "{channel} band {n} ({}): frequency {} Hz must be between 0 and Nyquist ({nyquist} Hz) at sample rate {sample_rate}",
                band.kind.label(),
                band.freq
            );
        }
        if band.q <= 0.0 {
            bail!(
                "{channel} band {n} ({}): Q must be > 0 (got {})",
                band.kind.label(),
                band.q
            );
        }

        if band.kind.gain_is_meaningful() && band.gain.abs() < UNITY_GAIN_DB {
            skipped_unity += 1;
            continue;
        }

        let biquad = design_one(band, sample_rate)?;
        let radius = biquad.pole_radius();
        if !radius.is_finite() || radius >= 1.0 {
            bail!(
                "{channel} band {n} ({} @ {} Hz, Q={}): unstable pole radius {radius}",
                band.kind.label(),
                band.freq,
                band.q
            );
        }
        biquads.push(biquad);
    }

    Ok(Designed {
        biquads,
        skipped_unity,
    })
}

fn design_one(band: &Band, sample_rate: f64) -> Result<Biquad> {
    let omega = std::f64::consts::TAU * band.freq / sample_rate;
    let (sn, cs) = omega.sin_cos();
    let alpha = sn / (2.0 * band.q);
    let a = 10f64.powf(band.gain / 40.0);
    let sqrt_a = a.sqrt();

    let (b0, b1, b2, a0, a1, a2) = match band.kind {
        FilterType::LowPass => {
            let b0 = (1.0 - cs) * 0.5;
            let b1 = 1.0 - cs;
            let b2 = b0;
            (b0, b1, b2, 1.0 + alpha, -2.0 * cs, 1.0 - alpha)
        }
        FilterType::HighPass => {
            let b0 = (1.0 + cs) * 0.5;
            let b1 = -(1.0 + cs);
            let b2 = b0;
            (b0, b1, b2, 1.0 + alpha, -2.0 * cs, 1.0 - alpha)
        }
        FilterType::BandPass => (alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cs, 1.0 - alpha),
        FilterType::Notch => (1.0, -2.0 * cs, 1.0, 1.0 + alpha, -2.0 * cs, 1.0 - alpha),
        FilterType::AllPass => (
            1.0 - alpha,
            -2.0 * cs,
            1.0 + alpha,
            1.0 + alpha,
            -2.0 * cs,
            1.0 - alpha,
        ),
        FilterType::Peak => (
            1.0 + alpha * a,
            -2.0 * cs,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cs,
            1.0 - alpha / a,
        ),
        FilterType::LowShelf => {
            let two_sa = 2.0 * sqrt_a * alpha;
            (
                a * ((a + 1.0) - (a - 1.0) * cs + two_sa),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cs),
                a * ((a + 1.0) - (a - 1.0) * cs - two_sa),
                (a + 1.0) + (a - 1.0) * cs + two_sa,
                -2.0 * ((a - 1.0) + (a + 1.0) * cs),
                (a + 1.0) + (a - 1.0) * cs - two_sa,
            )
        }
        FilterType::HighShelf => {
            let two_sa = 2.0 * sqrt_a * alpha;
            (
                a * ((a + 1.0) + (a - 1.0) * cs + two_sa),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cs),
                a * ((a + 1.0) + (a - 1.0) * cs - two_sa),
                (a + 1.0) - (a - 1.0) * cs + two_sa,
                2.0 * ((a - 1.0) - (a + 1.0) * cs),
                (a + 1.0) - (a - 1.0) * cs - two_sa,
            )
        }
    };

    if !a0.is_finite() || a0.abs() < 1e-30 {
        bail!(
            "degenerate coefficients for {} @ {} Hz",
            band.kind.label(),
            band.freq
        );
    }
    let inv = 1.0 / a0;
    Ok(Biquad {
        b0: b0 * inv,
        b1: b1 * inv,
        b2: b2 * inv,
        a1: a1 * inv,
        a2: a2 * inv,
        kind: band.kind,
        freq: band.freq,
        gain_db: band.gain,
        q: band.q,
    })
}

/// Magnitude of a cascade. Log-domain so a long stack of boosts cannot overflow.
pub fn cascade_magnitude(biquads: &[Biquad], omega: f64) -> f64 {
    if biquads.is_empty() {
        return 1.0;
    }
    let mut log_m = 0.0;
    for biquad in biquads {
        let m = biquad.magnitude(omega);
        if m == 0.0 {
            return 0.0;
        }
        if !m.is_finite() {
            return m;
        }
        log_m += m.ln();
    }
    log_m.exp()
}

pub fn cascade_magnitude_at(biquads: &[Biquad], freq_hz: f64, sample_rate: f64) -> f64 {
    let omega = std::f64::consts::TAU * freq_hz / sample_rate;
    cascade_magnitude(biquads, omega)
}

/// Samples of one-sided ringing required to push the slowest pole under `TAIL_AMP`.
pub fn onesided_tail_samples(biquads: &[Biquad]) -> usize {
    let mut worst = 32usize;
    for biquad in biquads {
        let r = biquad.pole_radius();
        if !r.is_finite() || r <= 0.0 || r >= 1.0 {
            continue;
        }
        let n = TAIL_AMP.ln() / r.ln();
        if n.is_finite() && n > 0.0 {
            let samples = if n >= MAX_FIR as f64 {
                MAX_FIR
            } else {
                n.ceil() as usize
            };
            worst = worst.max(samples);
        }
    }
    worst
}

/// Power-of-two FIR length for a linear-phase kernel, and whether it was capped.
pub fn choose_fir_length(biquads: &[Biquad]) -> (usize, bool) {
    let half = onesided_tail_samples(biquads).min(MAX_FIR);
    if half > MAX_FIR / 2 {
        return (MAX_FIR, true);
    }
    let need = (half * 2).max(MIN_FIR);
    let n = need.next_power_of_two();
    if n > MAX_FIR {
        (MAX_FIR, true)
    } else {
        (n, false)
    }
}

pub fn max_fir_len() -> usize {
    MAX_FIR
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Band, FilterType};

    fn band(kind: FilterType, freq: f64, gain: f64, q: f64) -> Band {
        Band {
            freq,
            gain,
            q,
            kind,
        }
    }

    fn mag_db(biquads: &[Biquad], freq: f64, sr: f64) -> f64 {
        20.0 * cascade_magnitude_at(biquads, freq, sr).log10()
    }

    #[test]
    fn lowshelf_dc_and_high_frequency() {
        let sr = 48_000.0;
        let designed =
            design_bands("left", &[band(FilterType::LowShelf, 80.0, 2.0, 0.7)], sr).unwrap();
        let dc = mag_db(&designed.biquads, 0.0, sr);
        assert!((dc - 2.0).abs() < 1e-9, "dc {dc}");
        let high = mag_db(&designed.biquads, 16_000.0, sr);
        assert!(high.abs() < 0.01, "high {high}");
    }

    #[test]
    fn highshelf_nyquist_approaches_gain() {
        let sr = 48_000.0;
        let designed = design_bands(
            "left",
            &[band(FilterType::HighShelf, 8_000.0, -3.0, 0.707)],
            sr,
        )
        .unwrap();
        let high = mag_db(&designed.biquads, 20_000.0, sr);
        assert!((high - (-3.0)).abs() < 0.15, "high {high}");
        let low = mag_db(&designed.biquads, 20.0, sr);
        assert!(low.abs() < 0.05, "low {low}");
    }

    #[test]
    fn peak_hits_specified_gain_at_center() {
        let sr = 48_000.0;
        let designed =
            design_bands("left", &[band(FilterType::Peak, 1_000.0, 6.0, 1.2)], sr).unwrap();
        let at = mag_db(&designed.biquads, 1_000.0, sr);
        assert!((at - 6.0).abs() < 1e-9, "center {at}");
        let far = mag_db(&designed.biquads, 100.0, sr);
        assert!(far.abs() < 0.2, "far {far}");
    }

    #[test]
    fn unity_bands_are_skipped() {
        let sr = 44_100.0;
        let designed = design_bands(
            "left",
            &[
                band(FilterType::Peak, 1_000.0, 0.0, 1.0),
                band(FilterType::LowShelf, 80.0, 1.5, 0.7),
                band(FilterType::HighShelf, 8_000.0, 0.0, 0.7),
            ],
            sr,
        )
        .unwrap();
        assert_eq!(designed.skipped_unity, 2);
        assert_eq!(designed.biquads.len(), 1);
    }

    #[test]
    fn lowpass_dc_is_unity_and_stable() {
        let sr = 48_000.0;
        let designed = design_bands(
            "left",
            &[band(FilterType::LowPass, 1_000.0, 0.0, 0.707)],
            sr,
        )
        .unwrap();
        let b = &designed.biquads[0];
        assert!(b.pole_radius() < 1.0);
        let dc = cascade_magnitude_at(&designed.biquads, 0.0, sr);
        assert!((dc - 1.0).abs() < 1e-12, "dc {dc}");
        let ny = cascade_magnitude_at(&designed.biquads, 20_000.0, sr);
        assert!(ny < 1e-3, "nyquist {ny}");
    }

    #[test]
    fn rejects_frequency_at_nyquist() {
        let err = design_bands(
            "right",
            &[band(FilterType::Peak, 24_000.0, 1.0, 1.0)],
            48_000.0,
        )
        .unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("Nyquist"), "{msg}");
    }

    #[test]
    fn gentle_eq_is_not_truncated() {
        let sr = 48_000.0;
        let designed = design_bands(
            "left",
            &[
                band(FilterType::LowShelf, 80.0, 2.0, 0.7),
                band(FilterType::Peak, 250.0, 0.5, 1.0),
            ],
            sr,
        )
        .unwrap();
        let (n, truncated) = choose_fir_length(&designed.biquads);
        assert!(!truncated, "n={n}");
        assert!(n.is_power_of_two());
        assert!(n <= max_fir_len());
        assert!(n >= 4096);
    }
}
