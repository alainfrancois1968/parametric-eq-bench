//! Channel processors.
//!
//! Minimum phase: cascaded transposed direct-form II biquads in f64.
//! Linear phase: the cascade magnitude is sampled on a long FFT grid, given
//! an integer group delay of N/2, inverted, and applied with overlap-add.
//! The delay is then removed so the file stays sample-aligned (zero phase,
//! which is linear phase with the constant delay compensated).

use std::sync::Arc;

use rayon::prelude::*;
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};

use crate::design::{cascade_magnitude, choose_fir_length, Biquad};

#[derive(Debug, Clone)]
pub struct LinearPhaseKernel {
    /// Real impulse with its energy centered at `delay_samples`.
    /// Empty means the cascade is unity and the channel is copied.
    pub impulse: Vec<f64>,
    pub truncated: bool,
    pub delay_samples: usize,
}

pub fn design_linear_phase(biquads: &[Biquad]) -> LinearPhaseKernel {
    if biquads.is_empty() {
        return LinearPhaseKernel {
            impulse: Vec::new(),
            truncated: false,
            delay_samples: 0,
        };
    }

    let (n, truncated) = choose_fir_length(biquads);
    let mut spectrum = vec![Complex::new(0.0, 0.0); n];
    // Each bin is independent. H[k] = |H(ωk)| * (-1)^k places the zero-phase
    // impulse at sample N/2 under rustfft's sign convention.
    spectrum.par_iter_mut().enumerate().for_each(|(k, bin)| {
        let omega = std::f64::consts::TAU * (k as f64) / (n as f64);
        let mag = cascade_magnitude(biquads, omega);
        let sign = if k % 2 == 0 { 1.0 } else { -1.0 };
        *bin = Complex::new(mag * sign, 0.0);
    });

    let mut planner = FftPlanner::<f64>::new();
    let ifft = planner.plan_fft_inverse(n);
    let mut scratch = vec![Complex::new(0.0, 0.0); ifft.get_inplace_scratch_len()];
    ifft.process_with_scratch(&mut spectrum, &mut scratch);

    let scale = 1.0 / n as f64;
    let mut impulse: Vec<f64> = spectrum.iter().map(|c| c.re * scale).collect();

    if truncated {
        // The slowest pole did not fit in the cap. A wide Kaiser window kills
        // the time-aliased tails instead of letting them wrap into the passband.
        apply_kaiser(&mut impulse, 20.0);
    }

    LinearPhaseKernel {
        impulse,
        truncated,
        delay_samples: n / 2,
    }
}

fn apply_kaiser(impulse: &mut [f64], beta: f64) {
    let n = impulse.len();
    if n < 2 {
        return;
    }
    let i0_beta = bessel_i0(beta);
    let half = n as f64 * 0.5;
    for (i, sample) in impulse.iter_mut().enumerate() {
        let x = (i as f64 - half).abs() / half;
        let w = if x >= 1.0 {
            0.0
        } else {
            bessel_i0(beta * (1.0 - x * x).sqrt()) / i0_beta
        };
        *sample *= w;
    }
}

/// Modified Bessel function I0. The series is stable for the betas used here.
fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = x * 0.5;
    for k in 1..80 {
        term *= half / k as f64;
        let add = term * term;
        sum += add;
        if add < sum * 1e-18 {
            break;
        }
    }
    sum
}

#[inline]
fn flush_denormal(x: f64) -> f64 {
    if x.abs() < 1e-30 {
        0.0
    } else {
        x
    }
}

/// Cascaded transposed direct form II. A unity cascade returns a bit-exact copy.
pub fn apply_minimum_phase(input: &[f64], biquads: &[Biquad]) -> Vec<f64> {
    let mut out = input.to_vec();
    if biquads.is_empty() || out.is_empty() {
        return out;
    }
    let mut s1 = vec![0.0f64; biquads.len()];
    let mut s2 = vec![0.0f64; biquads.len()];
    for sample in &mut out {
        let mut v = *sample;
        for (i, biquad) in biquads.iter().enumerate() {
            let y = biquad.b0 * v + s1[i];
            let next_s1 = biquad.b1 * v - biquad.a1 * y + s2[i];
            let next_s2 = biquad.b2 * v - biquad.a2 * y;
            s1[i] = flush_denormal(next_s1);
            s2[i] = flush_denormal(next_s2);
            v = y;
        }
        *sample = v;
    }
    out
}

/// Overlap-add convolution. Output length equals the input length; the kernel's
/// group delay (`impulse.len() / 2`) is removed.
pub fn apply_linear_phase(input: &[f64], kernel: &LinearPhaseKernel) -> Vec<f64> {
    if kernel.impulse.is_empty() || input.is_empty() {
        return input.to_vec();
    }
    convolve_ola(input, &kernel.impulse)
}

fn convolve_ola(input: &[f64], impulse: &[f64]) -> Vec<f64> {
    let n = impulse.len();
    debug_assert!(n.is_power_of_two() && n >= 2);
    let delay = n / 2;
    // fft_size = hop + N, with one sample of spare so circular conv == linear conv.
    let fft_size = n * 2;
    let hop = n;

    let mut planner = FftPlanner::<f64>::new();
    let fft: Arc<dyn Fft<f64>> = planner.plan_fft_forward(fft_size);
    let ifft: Arc<dyn Fft<f64>> = planner.plan_fft_inverse(fft_size);
    let scratch_fwd_len = fft.get_inplace_scratch_len();
    let scratch_inv_len = ifft.get_inplace_scratch_len();

    let mut h_freq = vec![Complex::new(0.0, 0.0); fft_size];
    for (i, &sample) in impulse.iter().enumerate() {
        h_freq[i].re = sample;
    }
    let mut scratch = vec![Complex::new(0.0, 0.0); scratch_fwd_len];
    fft.process_with_scratch(&mut h_freq, &mut scratch);
    let h_freq = Arc::new(h_freq);

    let y_len = input.len() + n - 1;
    let mut y_full = vec![0.0f64; y_len];
    let n_blocks = input.len().div_ceil(hop);
    // A few blocks per thread keeps the pool busy without holding every block's
    // FFT buffer at once.
    let batch = rayon::current_num_threads().max(1) * 4;

    let mut next = 0usize;
    while next < n_blocks {
        let end = (next + batch).min(n_blocks);
        let fft = Arc::clone(&fft);
        let ifft = Arc::clone(&ifft);
        let h_freq = Arc::clone(&h_freq);
        let parts: Vec<(usize, Vec<f64>)> = (next..end)
            .into_par_iter()
            .map_init(
                || {
                    (
                        vec![Complex::new(0.0, 0.0); scratch_fwd_len],
                        vec![Complex::new(0.0, 0.0); scratch_inv_len],
                    )
                },
                move |(scratch_fwd, scratch_inv), bi| {
                    let start = bi * hop;
                    let count = (input.len() - start).min(hop);
                    let mut buf = vec![Complex::new(0.0, 0.0); fft_size];
                    for i in 0..count {
                        buf[i].re = input[start + i];
                    }
                    fft.process_with_scratch(&mut buf, scratch_fwd);
                    for (bin, coeff) in buf.iter_mut().zip(h_freq.iter()) {
                        *bin *= *coeff;
                    }
                    ifft.process_with_scratch(&mut buf, scratch_inv);
                    let scale = 1.0 / fft_size as f64;
                    let time = buf.into_iter().map(|c| c.re * scale).collect();
                    (start, time)
                },
            )
            .collect();

        for (start, time) in parts {
            let m = time.len().min(y_len - start);
            for i in 0..m {
                y_full[start + i] += time[i];
            }
        }
        next = end;
    }

    y_full[delay..delay + input.len()].to_vec()
}

/// Parallel peak absolute value.
pub fn peak_abs(samples: &[f64]) -> f64 {
    samples.par_iter().map(|s| s.abs()).reduce(|| 0.0, f64::max)
}

/// Broadband gain. `db` of 0 leaves the buffer untouched.
pub fn apply_gain_db(samples: &mut [f64], db: f64) {
    if db == 0.0 || !db.is_finite() {
        return;
    }
    let gain = 10f64.powf(db / 20.0);
    for sample in samples {
        *sample *= gain;
    }
}

/// Scale each channel after its filters. Mono uses `left_db` only.
pub fn apply_preamp(channels: &mut [Vec<f64>], left_db: f64, right_db: f64) {
    if let Some(left) = channels.first_mut() {
        apply_gain_db(left, left_db);
    }
    if let Some(right) = channels.get_mut(1) {
        apply_gain_db(right, right_db);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Band, FilterType};
    use crate::design::{cascade_magnitude_at, design_bands};

    #[test]
    fn preamp_of_six_db_almost_doubles() {
        let mut channels = vec![vec![0.2, -0.4], vec![0.5]];
        apply_preamp(&mut channels, 6.0, 0.0);
        let expected = 0.2 * 10f64.powf(6.0 / 20.0);
        assert!((channels[0][0] - expected).abs() < 1e-12);
        assert!((channels[1][0] - 0.5).abs() < 1e-12);
    }

    fn band(kind: FilterType, freq: f64, gain: f64, q: f64) -> Band {
        Band {
            freq,
            gain,
            q,
            kind,
        }
    }

    fn naive_aligned(x: &[f64], h: &[f64]) -> Vec<f64> {
        let mut full = vec![0.0; x.len() + h.len() - 1];
        for (i, &xs) in x.iter().enumerate() {
            for (k, &hk) in h.iter().enumerate() {
                full[i + k] += xs * hk;
            }
        }
        let delay = h.len() / 2;
        full[delay..delay + x.len()].to_vec()
    }

    #[test]
    fn ola_matches_direct_convolution() {
        let n = 32;
        let mut h = vec![0.0; n];
        for (k, sample) in h.iter_mut().enumerate() {
            let d = k as f64 - (n / 2) as f64;
            *sample = (-0.5 * d * d / 6.0).exp() * if k % 3 == 0 { 0.5 } else { 1.0 };
        }
        let sum: f64 = h.iter().sum();
        for s in &mut h {
            *s /= sum;
        }
        let x: Vec<f64> = (0..50)
            .map(|i| ((i * 17) % 11) as f64 / 7.0 - 0.6)
            .collect();
        let kernel = LinearPhaseKernel {
            impulse: h.clone(),
            truncated: false,
            delay_samples: n / 2,
        };
        let y = apply_linear_phase(&x, &kernel);
        let reference = naive_aligned(&x, &h);
        assert_eq!(y.len(), x.len());
        for (i, (a, b)) in y.iter().zip(reference.iter()).enumerate() {
            assert!((a - b).abs() < 1e-9, "sample {i}: ola {a} vs direct {b}");
        }
    }

    #[test]
    fn identity_kernel_is_bit_close() {
        let mut h = vec![0.0; 16];
        h[8] = 1.0;
        let x = vec![0.2, -0.4, 0.6, 0.1, -0.3, 0.9, -1.0];
        let y = apply_linear_phase(
            &x,
            &LinearPhaseKernel {
                impulse: h,
                truncated: false,
                delay_samples: 8,
            },
        );
        for (a, b) in x.iter().zip(y.iter()) {
            assert!((a - b).abs() < 1e-12, "{a} vs {b}");
        }
    }

    #[test]
    fn minimum_phase_unity_is_exact_copy() {
        let x = vec![0.1, -0.2, 0.3];
        let y = apply_minimum_phase(&x, &[]);
        assert_eq!(x, y);
    }

    #[test]
    fn minimum_phase_sine_matches_cookbook_magnitude() {
        let sr = 48_000.0;
        // Off the peak center, so the biquad has both a gain and a phase shift.
        // At the center itself a peaking section is real and the phase is zero.
        let probe = 700.0;
        let designed =
            design_bands("left", &[band(FilterType::Peak, 1_000.0, 6.0, 1.0)], sr).unwrap();
        let n = sr as usize;
        let amp_in = 0.25;
        let x: Vec<f64> = (0..n)
            .map(|i| (std::f64::consts::TAU * probe * i as f64 / sr).cos() * amp_in)
            .collect();
        let y = apply_minimum_phase(&x, &designed.biquads);
        let expected = cascade_magnitude_at(&designed.biquads, probe, sr);
        let (amp, phase) = demodulate(&y, probe, sr, n / 5, 4 * n / 5);
        let got = amp / amp_in;
        assert!(
            (got - expected).abs() / expected < 1e-5,
            "got {got} expected {expected}"
        );
        assert!(
            phase.abs() > 0.05,
            "phase {phase} should have moved off the peak center"
        );
    }

    #[test]
    fn linear_phase_sine_matches_magnitude_and_stays_in_phase() {
        let sr = 48_000.0;
        let freq = 1_000.0;
        let designed = design_bands("left", &[band(FilterType::Peak, freq, 6.0, 1.0)], sr).unwrap();
        let kernel = design_linear_phase(&designed.biquads);
        assert!(!kernel.truncated);
        let guard = kernel.delay_samples + 64;
        let n = guard * 2 + sr as usize;
        let amp_in = 0.2;
        let x: Vec<f64> = (0..n)
            .map(|i| (std::f64::consts::TAU * freq * i as f64 / sr).cos() * amp_in)
            .collect();
        let y = apply_linear_phase(&x, &kernel);
        let expected = cascade_magnitude_at(&designed.biquads, freq, sr);
        let (amp, phase) = demodulate(&y, freq, sr, guard, n - guard);
        let got = amp / amp_in;
        assert!(
            (got - expected).abs() / expected < 1e-6,
            "got {got} expected {expected} fir {}",
            kernel.impulse.len()
        );
        assert!(phase.abs() < 1e-4, "phase {phase} should be ~0");
    }

    #[test]
    fn linear_phase_shelf_matches_at_two_frequencies() {
        let sr = 48_000.0;
        let designed =
            design_bands("left", &[band(FilterType::LowShelf, 80.0, 2.0, 0.7)], sr).unwrap();
        let kernel = design_linear_phase(&designed.biquads);
        assert!(!kernel.truncated, "len {}", kernel.impulse.len());
        let guard = kernel.delay_samples + 1024;
        let n = guard * 2 + sr as usize;
        for freq in [30.0, 4_000.0] {
            let amp_in = 0.3;
            let x: Vec<f64> = (0..n)
                .map(|i| (std::f64::consts::TAU * freq * i as f64 / sr).cos() * amp_in)
                .collect();
            let y = apply_linear_phase(&x, &kernel);
            let expected = cascade_magnitude_at(&designed.biquads, freq, sr);
            let (amp, phase) = demodulate(&y, freq, sr, guard, n - guard);
            let got = amp / amp_in;
            assert!(
                (got - expected).abs() / expected.max(1e-9) < 1e-4,
                "f={freq} got {got} expected {expected} (fir {})",
                kernel.impulse.len()
            );
            assert!(phase.abs() < 1e-3, "f={freq} phase {phase}");
        }
    }

    fn demodulate(y: &[f64], freq: f64, sr: f64, start: usize, end: usize) -> (f64, f64) {
        let mut re = 0.0;
        let mut im = 0.0;
        let count = (end - start) as f64;
        for (i, &s) in y[start..end].iter().enumerate() {
            let w = std::f64::consts::TAU * freq * (start + i) as f64 / sr;
            re += s * w.cos();
            im += s * w.sin();
        }
        re *= 2.0 / count;
        im *= 2.0 / count;
        ((re * re + im * im).sqrt(), im.atan2(re))
    }
}
