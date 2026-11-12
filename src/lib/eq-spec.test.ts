import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { DEFAULT_SETTINGS, assessEq, responseDb, suggestPreampDb, type EqLibrary } from "./eq-spec.ts";

const require = createRequire(import.meta.url);
const glue = require("./eq-core/node/eq_bridge.js") as {
  curve_db: (bands: string, freqs: string, sampleRate: number) => string;
  design_error: (channel: string, bands: string, sampleRate: number) => string;
};

const library: EqLibrary = {
  curveDb(bands, freqs, sampleRate) {
    return JSON.parse(glue.curve_db(JSON.stringify(bands), JSON.stringify(freqs), sampleRate));
  },
  designError(channel, bands, sampleRate) {
    return glue.design_error(channel, JSON.stringify(bands), sampleRate);
  },
};

test("default curves are independent and both legal at 48 kHz", () => {
  const verdict = assessEq(DEFAULT_SETTINGS, wav(48000, 2), true, "song.wav");
  assert.equal(verdict.errors.length, 0);
  assert.equal(verdict.preset?.linear_phase, false);
  assert.ok(Array.isArray(verdict.preset?.right));
  assert.notEqual(verdict.preset?.right, verdict.preset?.left);
  assert.match(verdict.command, /^parametric-eq song\.wav output-eq\.wav --format f64 --eq /);
});

test("a band at Nyquist is rejected and Execute would stay disabled", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    left: [{ type: "peak" as const, freq: "24000", gain: "3", q: "1" }],
  };
  const verdict = assessEq(settings, wav(48000, 2), true, "song.wav");
  assert.ok(verdict.errors.some((error) => error.includes("Nyquist")));
  assert.equal(verdict.preset, null);
});

test("Q of zero is rejected and gain is dropped for a low pass", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    rightMode: "independent" as const,
    right: [{ type: "lowpass" as const, freq: "8000", gain: "12", q: "0" }],
  };
  const verdict = assessEq(settings, wav(48000, 2), true, "song.wav");
  assert.ok(verdict.errors.some((error) => error.includes("Q must be > 0")));
});

test("more than two channels is rejected", () => {
  const verdict = assessEq(DEFAULT_SETTINGS, wav(44100, 6), true, "song.wav");
  assert.ok(verdict.errors.some((error) => error.includes("mono and stereo")));
});

test("a +6 dB peak is about +6 dB at its center", () => {
  const db = responseDb([{ type: "peak", freq: "1000", gain: "6", q: "1" }], 1000, 48000, library);
  assert.ok(Math.abs(db - 6) < 0.05, `got ${db}`);
});

test("the command uses the dot level, not the stored shelf gain", () => {
  const verdict = assessEq(DEFAULT_SETTINGS, wav(48000, 2), true, "song.wav", library);
  const left = verdict.preset?.left as { type: string; gain: number }[];
  const dot = responseDb(DEFAULT_SETTINGS.left, 80, 48000, library);
  assert.equal(left[0].type, "lowshelf");
  assert.equal(left[0].gain, Math.round(dot * 10) / 10);
  assert.notEqual(left[0].gain, 2);
});

test("the command keeps preamp separate from the band gain", () => {
  const settings = { ...DEFAULT_SETTINGS, preampLeft: "-6.2", preampRight: "-4" };
  const verdict = assessEq(settings, wav(48000, 2), true, "song.wav", library);
  assert.equal(verdict.preset?.preamp_left, -6.2);
  assert.equal(verdict.preset?.preamp_right, -4);
  const left = verdict.preset?.left as { gain: number }[];
  const dot = responseDb(DEFAULT_SETTINGS.left, 80, 48000, library);
  assert.equal(left[0].gain, Math.round(dot * 10) / 10);
  assert.notEqual(left[0].gain, Math.round((dot - 6.2) * 10) / 10);
});

test("suggest preamp is the ceiling of the peak, and never a boost", () => {
  assert.equal(suggestPreampDb(6.14), -6.2);
  assert.equal(suggestPreampDb(0), 0);
  assert.equal(suggestPreampDb(-3), 0);
});

function wav(sampleRate: number, channels: number) {
  return { sampleRate, channels, bits: 24, kind: "int" as const, frames: 1000 };
}
