import { responseCurve, type BandDraft, type EqLibrary, type FilterId } from "./eq-spec.ts";

export type DrawPoint = { hz: number; db: number };

type Guess = { type: FilterId; freq: number; gain: number; q: number };

const MAX_BANDS = 8;

export function fitDrawnCurve(raw: DrawPoint[], sampleRate: number, library: EqLibrary | null): BandDraft[] {
  const nyquist = sampleRate > 0 ? sampleRate / 2 : 24000;
  const fMin = 20;
  const fMax = Math.max(fMin * 2, Math.min(nyquist * 0.999, nyquist));
  const curve = smoothCurve(resample(raw, fMin, fMax, 96));
  if (curve.length < 8) return [];

  const cuts = detectCutoffs(curve);
  const shelves = detectShelves(curve).filter((band) => {
    if (band.type === "lowshelf" && cuts.some((cut) => cut.type === "highpass")) return false;
    if (band.type === "highshelf" && cuts.some((cut) => cut.type === "lowpass")) return false;
    return true;
  });
  const peaks = detectPeaks(curve);
  const guesses = [...cuts, ...shelves, ...peaks]
    .sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain))
    .slice(0, MAX_BANDS);
  const fitted = library ? refine(guesses, curve, sampleRate, library) : guesses;
  return fitted
    .map(toDraft)
    .sort((a, b) => Number(a.freq) - Number(b.freq));
}

function resample(raw: DrawPoint[], fMin: number, fMax: number, count: number): DrawPoint[] {
  const buckets = new Map<number, number>();
  const span = Math.log(fMax) - Math.log(fMin);
  for (const point of raw) {
    if (!(point.hz >= fMin && point.hz <= fMax) || !Number.isFinite(point.db)) continue;
    const slot = Math.round(((Math.log(point.hz) - Math.log(fMin)) / span) * (count - 1));
    buckets.set(slot, clamp(point.db, -36, 36));
  }
  if (buckets.size < 2) return [];
  const lo = Math.min(...buckets.keys());
  const hi = Math.max(...buckets.keys());
  const out: DrawPoint[] = [];
  let previous = buckets.get(lo) ?? 0;
  for (let slot = lo; slot <= hi; slot += 1) {
    const db = buckets.get(slot);
    const value = db ?? previous;
    previous = value;
    const hz = Math.exp(Math.log(fMin) + (slot / (count - 1)) * span);
    out.push({ hz, db: clamp(value, -36, 36) });
  }
  return out;
}

function smoothCurve(points: DrawPoint[]): DrawPoint[] {
  if (points.length < 5) return points;
  const db = points.map((point) => point.db);
  const once = blur(db);
  const twice = blur(once);
  return points.map((point, index) => ({ hz: point.hz, db: twice[index] ?? point.db }));
}

function blur(values: number[]): number[] {
  return values.map((value, index) => {
    const a = values[index - 1] ?? value;
    const b = values[index + 1] ?? value;
    return (a + value * 2 + b) / 4;
  });
}

function detectShelves(curve: DrawPoint[]): Guess[] {
  const mid = median(curve.map((point) => point.db));
  const left = average(curve.slice(0, Math.max(3, Math.floor(curve.length * 0.08))));
  const right = average(curve.slice(Math.floor(curve.length * 0.92)));
  const bands: Guess[] = [];
  if (Math.abs(left - mid) >= 1.5) {
    bands.push({
      type: "lowshelf",
      freq: crossing(curve, left, mid, true),
      gain: clamp(left - mid, -36, 36),
      q: 0.7,
    });
  }
  if (Math.abs(right - mid) >= 1.5) {
    bands.push({
      type: "highshelf",
      freq: crossing(curve, right, mid, false),
      gain: clamp(right - mid, -36, 36),
      q: 0.7,
    });
  }
  return bands;
}

function detectCutoffs(curve: DrawPoint[]): Guess[] {
  const mid = median(curve.map((point) => point.db));
  const left = average(curve.slice(0, Math.max(3, Math.floor(curve.length * 0.1))));
  const right = average(curve.slice(Math.floor(curve.length * 0.9)));
  const bands: Guess[] = [];
  if (right < mid - 16 && falling(curve, false)) {
    bands.push({ type: "lowpass", freq: levelCrossing(curve, mid - 3, false), gain: 0, q: cutoffQ(curve, false) });
  }
  if (left < mid - 16 && falling(curve, true)) {
    bands.push({ type: "highpass", freq: levelCrossing(curve, mid - 3, true), gain: 0, q: cutoffQ(curve, true) });
  }
  return bands;
}

function detectPeaks(curve: DrawPoint[]): Guess[] {
  const found: { index: number; prominence: number; up: boolean }[] = [];
  for (let index = 2; index < curve.length - 2; index += 1) {
    const y = curve[index].db;
    const up =
      y >= curve[index - 1].db &&
      y >= curve[index + 1].db &&
      y > curve[index - 2].db &&
      y > curve[index + 2].db;
    const down =
      y <= curve[index - 1].db &&
      y <= curve[index + 1].db &&
      y < curve[index - 2].db &&
      y < curve[index + 2].db;
    if (!up && !down) continue;
    const left = shoulder(curve, index, -1, up);
    const right = shoulder(curve, index, 1, up);
    const baseline = (curve[left].db + curve[right].db) / 2;
    const prominence = up ? y - baseline : baseline - y;
    if (prominence < 1.25) continue;
    found.push({ index, prominence, up });
  }
  found.sort((a, b) => b.prominence - a.prominence);
  const kept: typeof found = [];
  for (const peak of found) {
    const hz = curve[peak.index].hz;
    if (kept.some((item) => Math.abs(Math.log2(curve[item.index].hz / hz)) < 0.4)) continue;
    kept.push(peak);
    if (kept.length >= 6) break;
  }
  return kept.map((peak) => {
    const y = curve[peak.index].db;
    const left = shoulder(curve, peak.index, -1, peak.up);
    const right = shoulder(curve, peak.index, 1, peak.up);
    const baseline = (curve[left].db + curve[right].db) / 2;
    const octaves = bandwidth(curve, peak.index, baseline, peak.up);
    const q = qFromBandwidth(octaves);
    const gain = clamp(y - baseline, -36, 36);
    if (!peak.up && Math.abs(gain) >= 14 && q >= 3) {
      return { type: "notch" as const, freq: curve[peak.index].hz, gain: 0, q };
    }
    return { type: "peak" as const, freq: curve[peak.index].hz, gain, q };
  });
}

function refine(guesses: Guess[], curve: DrawPoint[], sampleRate: number, library: EqLibrary): Guess[] {
  const freqs = curve.map((point) => point.hz);
  const target = curve.map((point) => point.db);
  let current = guesses.map((band) => ({ ...band }));
  const scoreOf = (bands: Guess[]) => mse(responseCurve(bands.map(toDraft), freqs, sampleRate, library), target);
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < current.length; index += 1) {
      const band = current[index];
      let best = current;
      let bestScore = scoreOf(current);
      const qs = [band.q / 2, band.q / 1.35, band.q, band.q * 1.35, band.q * 2].map((q) => clamp(q, 0.3, 12));
      const gains =
        band.type === "peak" || band.type === "lowshelf" || band.type === "highshelf"
          ? [-6, -3, -1.5, 0, 1.5, 3, 6].map((offset) => clamp(band.gain + offset, -36, 36))
          : [band.gain];
      for (const gain of gains) {
        for (const q of qs) {
          const next = current.map((item, itemIndex) => (itemIndex === index ? { ...item, gain, q } : item));
          const score = scoreOf(next);
          if (score + 0.05 < bestScore) {
            best = next;
            bestScore = score;
          }
        }
      }
      current = best;
    }
  }
  return current;
}

function shoulder(curve: DrawPoint[], index: number, direction: number, up: boolean): number {
  let best = index;
  let extreme = curve[index].db;
  for (let cursor = index + direction; cursor > 0 && cursor < curve.length - 1; cursor += direction) {
    if (Math.abs(Math.log2(curve[cursor].hz / curve[index].hz)) > 3.5) break;
    const db = curve[cursor].db;
    if (up ? db < extreme : db > extreme) {
      extreme = db;
      best = cursor;
    } else if (up ? db > extreme + 0.7 : db < extreme - 0.7) {
      break;
    }
  }
  return best;
}

function bandwidth(curve: DrawPoint[], index: number, baseline: number, up: boolean): number {
  const half = (curve[index].db + baseline) / 2;
  let left = 0;
  let right = curve.length - 1;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    left = cursor;
    if (up ? curve[cursor].db <= half : curve[cursor].db >= half) break;
  }
  for (let cursor = index; cursor < curve.length; cursor += 1) {
    right = cursor;
    if (up ? curve[cursor].db <= half : curve[cursor].db >= half) break;
  }
  return Math.log2(curve[right].hz / Math.max(curve[left].hz, 1));
}

function qFromBandwidth(octaves: number): number {
  const bw = clamp(octaves, 0.12, 5);
  const q = 1 / (2 * Math.sinh((Math.LN2 / 2) * bw));
  return clamp(q, 0.3, 12);
}

function crossing(curve: DrawPoint[], end: number, mid: number, fromLeft: boolean): number {
  const halfway = (end + mid) / 2;
  const indexes = fromLeft ? curve.map((_, index) => index) : curve.map((_, index) => curve.length - 1 - index);
  for (const index of indexes) {
    const db = curve[index].db;
    if ((end > mid && db <= halfway) || (end < mid && db >= halfway)) return curve[index].hz;
  }
  return curve[fromLeft ? Math.floor(curve.length * 0.2) : Math.floor(curve.length * 0.8)].hz;
}

function levelCrossing(curve: DrawPoint[], level: number, fromLeft: boolean): number {
  const indexes = fromLeft ? curve.map((_, index) => index) : curve.map((_, index) => curve.length - 1 - index);
  for (const index of indexes) {
    if (curve[index].db >= level) return curve[index].hz;
  }
  return curve[fromLeft ? 0 : curve.length - 1].hz;
}

function falling(curve: DrawPoint[], fromLeft: boolean): boolean {
  const slice = fromLeft ? curve.slice(0, Math.floor(curve.length * 0.25)) : curve.slice(Math.floor(curve.length * 0.75));
  if (slice.length < 3) return false;
  const start = slice[0].db;
  const end = slice[slice.length - 1].db;
  return fromLeft ? start < end - 6 : end < start - 6;
}

function cutoffQ(curve: DrawPoint[], fromLeft: boolean): number {
  const slice = fromLeft ? curve.slice(0, Math.floor(curve.length * 0.3)) : curve.slice(Math.floor(curve.length * 0.7));
  if (slice.length < 2) return 0.7;
  const drop = Math.abs(slice[slice.length - 1].db - slice[0].db);
  const octaves = Math.abs(Math.log2(slice[slice.length - 1].hz / slice[0].hz));
  if (drop < 6 || octaves <= 0) return 0.7;
  return clamp(qFromBandwidth((octaves * 12) / drop), 0.5, 8);
}

function mse(got: number[], target: number[]): number {
  let sum = 0;
  for (let index = 0; index < target.length; index += 1) {
    const delta = (got[index] ?? 0) - target[index];
    sum += delta * delta;
  }
  return sum / Math.max(1, target.length);
}

function toDraft(band: Guess): BandDraft {
  return {
    type: band.type,
    freq: formatNum(band.freq, band.freq >= 100 ? 0 : 1),
    gain: formatNum(band.gain, 1),
    q: formatNum(band.q, 2),
  };
}

function average(points: DrawPoint[]): number {
  if (!points.length) return 0;
  return points.reduce((sum, point) => sum + point.db, 0) / points.length;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function formatNum(value: number, digits: number): string {
  const scale = 10 ** digits;
  return String(Math.round(value * scale) / scale);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
