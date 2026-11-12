//! Calls `parametric-eq` for cascade magnitude. This crate has no filter formulas.

use parametric_eq::design::{cascade_magnitude_at, design_bands};
use parametric_eq::Band;
use wasm_bindgen::prelude::*;

fn bands_from_json(json: &str) -> Result<Vec<Band>, String> {
    serde_json::from_str(json).map_err(|err| err.to_string())
}

/// JSON bands `[{type,freq,gain,q}]` and JSON frequency list. Returns a JSON array of dB.
#[wasm_bindgen]
pub fn curve_db(bands_json: &str, freqs_json: &str, sample_rate: f64) -> String {
    let bands = match bands_from_json(bands_json) {
        Ok(bands) => bands,
        Err(err) => return serde_json::json!({ "error": err }).to_string(),
    };
    let freqs: Vec<f64> = match serde_json::from_str(freqs_json) {
        Ok(freqs) => freqs,
        Err(err) => return serde_json::json!({ "error": err.to_string() }).to_string(),
    };
    let designed = match design_bands("curve", &bands, sample_rate) {
        Ok(designed) => designed,
        Err(err) => return serde_json::json!({ "error": err.to_string() }).to_string(),
    };
    let mut out = Vec::with_capacity(freqs.len());
    for hz in freqs {
        let magnitude = cascade_magnitude_at(&designed.biquads, hz, sample_rate);
        let db = if magnitude.is_finite() && magnitude > 0.0 {
            20.0 * magnitude.log10()
        } else {
            -240.0
        };
        out.push(serde_json::json!(db));
    }
    serde_json::Value::Array(out).to_string()
}

/// Empty string when the library accepts the bands. Otherwise the library's error.
#[wasm_bindgen]
pub fn design_error(channel: &str, bands_json: &str, sample_rate: f64) -> String {
    let bands = match bands_from_json(bands_json) {
        Ok(bands) => bands,
        Err(err) => return err,
    };
    match design_bands(channel, &bands, sample_rate) {
        Ok(_) => String::new(),
        Err(err) => err.to_string(),
    }
}
