import { createRequire } from "node:module";

import type { EqLibrary } from "@/lib/eq-spec";

type NumericBand = { type: string; freq: number; gain: number; q: number };
type Glue = {
  curve_db: (bands: string, freqs: string, sampleRate: number) => string;
  design_error: (channel: string, bands: string, sampleRate: number) => string;
};

const require = createRequire(import.meta.url);
const glue = require("./eq-core/node/eq_bridge.js") as Glue;

export function nodeEqLibrary(): EqLibrary {
  return {
    curveDb(bands: NumericBand[], freqs: number[], sampleRate: number) {
      return JSON.parse(glue.curve_db(JSON.stringify(bands), JSON.stringify(freqs), sampleRate)) as
        | number[]
        | { error: string };
    },
    designError(channel: string, bands: NumericBand[], sampleRate: number) {
      return glue.design_error(channel, JSON.stringify(bands), sampleRate);
    },
  };
}
