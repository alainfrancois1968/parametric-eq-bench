//! JSON preset schema.
//!
//! Gain is decibels. Q is the RBJ / Web Audio Q (for shelves, Q ≈ 0.707 is the
//! standard gentle slope). `linear_phase` selects zero-phase FIR processing.

use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterType {
    Peak,
    LowShelf,
    HighShelf,
    LowPass,
    HighPass,
    Notch,
    BandPass,
    AllPass,
}

impl FilterType {
    pub fn parse(raw: &str) -> Option<Self> {
        let key: String = raw
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .flat_map(|c| c.to_lowercase())
            .collect();
        Some(match key.as_str() {
            "peak" | "peaking" | "bell" | "pk" => Self::Peak,
            "lowshelf" | "lshelf" | "bassshelf" | "ls" => Self::LowShelf,
            "highshelf" | "hshelf" | "trebleshelf" | "hs" => Self::HighShelf,
            "lowpass" | "lp" | "lpf" => Self::LowPass,
            "highpass" | "hp" | "hpf" => Self::HighPass,
            "notch" | "bandstop" | "bandreject" | "bs" => Self::Notch,
            "bandpass" | "bp" | "bpf" => Self::BandPass,
            "allpass" | "ap" | "apf" => Self::AllPass,
            _ => return None,
        })
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Peak => "peak",
            Self::LowShelf => "lowshelf",
            Self::HighShelf => "highshelf",
            Self::LowPass => "lowpass",
            Self::HighPass => "highpass",
            Self::Notch => "notch",
            Self::BandPass => "bandpass",
            Self::AllPass => "allpass",
        }
    }

    /// Peak and shelf bands with a 0 dB gain are exactly unity and are skipped.
    pub fn gain_is_meaningful(self) -> bool {
        matches!(self, Self::Peak | Self::LowShelf | Self::HighShelf)
    }
}

impl<'de> Deserialize<'de> for FilterType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::parse(&s).ok_or_else(|| {
            de::Error::custom(format!(
                "unknown filter type '{s}'. Expected peak, lowshelf, highshelf, lowpass, highpass, notch, bandpass, or allpass"
            ))
        })
    }
}

impl Serialize for FilterType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.label())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Band {
    pub freq: f64,
    /// Gain in dB. Ignored for lowpass, highpass, notch, bandpass, and allpass.
    #[serde(default)]
    pub gain: f64,
    pub q: f64,
    #[serde(rename = "type")]
    pub kind: FilterType,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Preset {
    #[serde(default)]
    pub name: Option<String>,
    /// When true, each channel is filtered by a zero-phase FIR whose magnitude
    /// matches the biquad cascade. The group delay is removed so the output
    /// stays sample-aligned with the input.
    #[serde(default)]
    pub linear_phase: bool,
    pub left: Vec<Band>,
    /// Missing or null: copy `left`. An empty array is a true bypass on the right.
    #[serde(default)]
    pub right: Option<Vec<Band>>,
}

impl Preset {
    pub fn right_bands(&self) -> &[Band] {
        self.right.as_deref().unwrap_or(&self.left)
    }

    pub fn right_was_omitted(&self) -> bool {
        self.right.is_none()
    }
}

/// Load a preset from a JSON string, `@path`, or a bare path to a JSON file.
pub fn load_preset(input: &str) -> Result<Preset> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        bail!("EQ settings are empty");
    }
    let json = if let Some(path) = trimmed.strip_prefix('@') {
        let path = path.trim();
        if path.is_empty() {
            bail!("expected a file path after @");
        }
        read_json_file(Path::new(path))?
    } else if trimmed.starts_with('{') {
        trimmed.to_string()
    } else if Path::new(trimmed).is_file() {
        read_json_file(Path::new(trimmed))?
    } else {
        trimmed.to_string()
    };
    serde_json::from_str(&json).with_context(|| "failed to parse EQ JSON")
}

fn read_json_file(path: &Path) -> Result<String> {
    fs::read_to_string(path).with_context(|| format!("failed to read EQ file {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = r#"{
        "left": [
            {"freq": 80, "gain": 2.0, "q": 0.7, "type": "lowshelf"},
            {"freq": 250, "gain": 0.5, "q": 1.0, "type": "peak"}
        ],
        "linear_phase": true,
        "name": "Slightly boost bass",
        "right": [
            {"freq": 80, "gain": 2.0, "q": 0.7, "type": "lowshelf"},
            {"freq": 250, "gain": 0.5, "q": 1.0, "type": "peak"}
        ]
    }"#;

    #[test]
    fn parses_example_shape() {
        let p = load_preset(EXAMPLE).unwrap();
        assert_eq!(p.name.as_deref(), Some("Slightly boost bass"));
        assert!(p.linear_phase);
        assert_eq!(p.left.len(), 2);
        assert_eq!(p.left[0].kind, FilterType::LowShelf);
        assert_eq!(p.left[0].freq, 80.0);
        assert_eq!(p.left[1].gain, 0.5);
        assert!(!p.right_was_omitted());
    }

    #[test]
    fn omitted_right_copies_left() {
        let p = load_preset(r#"{"left":[{"freq":1000,"gain":3,"q":1,"type":"peak"}]}"#).unwrap();
        assert!(p.right_was_omitted());
        assert_eq!(p.right_bands(), p.left.as_slice());
        assert!(!p.linear_phase);
    }

    #[test]
    fn accepts_type_aliases() {
        for (raw, kind) in [
            ("Low-Shelf", FilterType::LowShelf),
            ("high shelf", FilterType::HighShelf),
            ("Peaking", FilterType::Peak),
            ("LPF", FilterType::LowPass),
            ("band-stop", FilterType::Notch),
        ] {
            assert_eq!(FilterType::parse(raw), Some(kind), "{raw}");
        }
    }
}
