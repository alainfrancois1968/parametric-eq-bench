//! High-quality parametric EQ for WAV files.
//!
//! The signal path is f64. Minimum-phase mode cascades RBJ biquads.
//! Linear-phase mode builds a zero-phase FIR from the cascade magnitude and
//! removes the group delay so the output stays sample-aligned.

#![forbid(unsafe_code)]

pub mod config;
pub mod design;
pub mod process;
pub mod wavio;

pub use config::{load_preset, Band, FilterType, Preset};
pub use design::{design_bands, Biquad, Designed};
pub use process::{
    apply_gain_db, apply_linear_phase, apply_minimum_phase, apply_preamp, design_linear_phase,
    peak_abs, LinearPhaseKernel,
};
pub use wavio::{read_wav, write_wav, Audio, OutFormat, SourceFormat};
