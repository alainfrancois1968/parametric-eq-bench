import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { responseCurve, type EqLibrary } from "./eq-spec.ts";
import { fitDrawnCurve } from "./fit-curve.ts";

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

test("a drawn +6 dB peak becomes a peak near that frequency", () => {
  const freqs = Array.from({ length: 80 }, (_, index) => 20 * 2 ** ((index / 79) * Math.log2(20000 / 20)));
  const levels = responseCurve([{ type: "peak", freq: "1000", gain: "6", q: "1" }], freqs, 48000, library);
  const fitted = fitDrawnCurve(
    freqs.map((hz, index) => ({ hz, db: levels[index] ?? 0 })),
    48000,
    library,
  );
  const peak = fitted.find((band) => band.type === "peak");
  assert.ok(peak, `expected a peak, got ${JSON.stringify(fitted)}`);
  assert.ok(Math.abs(Number(peak.freq) - 1000) < 300, peak.freq);
  assert.ok(Math.abs(Number(peak.gain) - 6) < 2.5, peak.gain);
  assert.ok(Number(peak.q) > 0.3 && Number(peak.q) < 4, peak.q);
});
