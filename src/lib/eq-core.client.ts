import { curve_db, design_error } from "@/lib/eq-core/bundler/eq_bridge.js";
import type { EqLibrary } from "@/lib/eq-spec";

type NumericBand = { type: string; freq: number; gain: number; q: number };

export function browserEqLibrary(): EqLibrary {
  return {
    curveDb(bands: NumericBand[], freqs: number[], sampleRate: number) {
      const parsed = JSON.parse(curve_db(JSON.stringify(bands), JSON.stringify(freqs), sampleRate)) as
        | number[]
        | { error: string };
      return parsed;
    },
    designError(channel: string, bands: NumericBand[], sampleRate: number) {
      return design_error(channel, JSON.stringify(bands), sampleRate);
    },
  };
}
