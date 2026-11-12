import type { WavFacts } from "@/lib/cli-spec";

export const FILTERS = [
  { id: "peak", label: "Peak", detail: "Bell. Gain is dB at the center frequency.", gain: true },
  { id: "lowshelf", label: "Low shelf", detail: "Boost or cut below the corner. Q 0.707 is the gentle shelf.", gain: true },
  { id: "highshelf", label: "High shelf", detail: "Boost or cut above the corner. Q 0.707 is the gentle shelf.", gain: true },
  { id: "lowpass", label: "Low pass", detail: "Gain is ignored. Q 0.707 is Butterworth.", gain: false },
  { id: "highpass", label: "High pass", detail: "Gain is ignored. Q 0.707 is Butterworth.", gain: false },
  { id: "notch", label: "Notch", detail: "Gain is ignored. Cuts the center frequency.", gain: false },
  { id: "bandpass", label: "Band pass", detail: "Gain is ignored. 0 dB at the center frequency.", gain: false },
  { id: "allpass", label: "Allpass", detail: "Phase only. Linear-phase mode skips it.", gain: false },
] as const;

export const FORMATS = [
  { id: "f64", label: "64-bit float", detail: "Default. Overs are kept, not clipped." },
  { id: "f32", label: "32-bit float", detail: "Overs are kept, not clipped." },
  { id: "i24", label: "24-bit PCM", detail: "TPDF dither and first-order noise shaping. Clips above 0 dBFS." },
  { id: "i16", label: "16-bit PCM", detail: "TPDF dither and first-order noise shaping. Clips above 0 dBFS." },
] as const;

export const RIGHT_MODES = [
  { id: "copy", label: "Same as left", detail: "Right is omitted, so the left curve is copied." },
  { id: "independent", label: "Different curve", detail: "Right has its own bands." },
  { id: "bypass", label: "Bypass right", detail: "Right is an empty list, so that channel is untouched." },
] as const;

export type FilterId = (typeof FILTERS)[number]["id"];
export type FormatId = (typeof FORMATS)[number]["id"];
export type RightMode = (typeof RIGHT_MODES)[number]["id"];

export type BandDraft = {
  type: FilterId;
  freq: string;
  gain: string;
  q: string;
};

export type EqSettings = {
  name: string;
  linearPhase: boolean;
  preampLeft: string;
  preampRight: string;
  left: BandDraft[];
  rightMode: RightMode;
  right: BandDraft[];
  format: FormatId;
  outputName: string;
  overwrite: boolean;
};

export const DEFAULT_SETTINGS: EqSettings = {
  name: "Slightly boost bass",
  linearPhase: false,
  preampLeft: "0",
  preampRight: "0",
  left: [
    { type: "lowshelf", freq: "80", gain: "2", q: "0.7" },
    { type: "peak", freq: "250", gain: "0.5", q: "1" },
  ],
  rightMode: "independent",
  right: [
    { type: "lowshelf", freq: "80", gain: "2", q: "0.7" },
    { type: "peak", freq: "250", gain: "0.5", q: "1" },
  ],
  format: "f64",
  outputName: "output-eq.wav",
  overwrite: false,
};

export type EqLibrary = {
  curveDb: (
    bands: { type: string; freq: number; gain: number; q: number }[],
    freqs: number[],
    sampleRate: number,
  ) => number[] | { error: string };
  designError: (
    channel: string,
    bands: { type: string; freq: number; gain: number; q: number }[],
    sampleRate: number,
  ) => string;
};

export type EqAssessment = {
  errors: string[];
  notes: string[];
  command: string;
  preset: Record<string, unknown> | null;
};

const NAME_RE = /^[\w .()-]{1,120}$/;

function sanitizeOutputName(name: string): string | null {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) return null;
  if (trimmed.includes("..") || trimmed.startsWith(".")) return null;
  if (!trimmed.toLowerCase().endsWith(".wav")) return null;
  return trimmed;
}

export function gainMatters(type: FilterId): boolean {
  const found = FILTERS.find((item) => item.id === type);
  return found ? found.gain : false;
}

export function suggestEqName(inputName: string): string {
  const stem = inputName.replace(/\.wav$/i, "").replace(/[^\w .()-]+/g, "").trim() || "output";
  return sanitizeOutputName(`${stem}-eq.wav`) ?? "output-eq.wav";
}

type ParsedBand = { type: FilterId; freq: number; gain: number; q: number };

export function assessEq(
  settings: EqSettings,
  wav: WavFacts | null,
  hasInput: boolean,
  inputName: string,
  library: EqLibrary | null = null,
): EqAssessment {
  const errors: string[] = [];
  const notes: string[] = [];
  if (!hasInput) errors.push("Choose an input WAV.");
  if (wav && wav.channels > 2) {
    errors.push(`Input has ${wav.channels} channels. This tool processes mono and stereo only.`);
  }
  if (wav && wav.frames === 0) errors.push("Input WAV has no samples.");
  if (wav && (wav.sampleRate <= 0 || !Number.isFinite(wav.sampleRate))) {
    errors.push("Input sample rate is not usable.");
  }

  const nyquist = wav && wav.sampleRate > 0 ? wav.sampleRate / 2 : null;
  const sampleRate = wav && wav.sampleRate > 0 ? wav.sampleRate : null;
  const left = parseChannel("left", settings.left, nyquist, errors, library, sampleRate);
  const right =
    settings.rightMode === "independent"
      ? parseChannel("right", settings.right, nyquist, errors, library, sampleRate)
      : [];

  if (settings.linearPhase) {
    const allpass =
      settings.left.some((band) => band.type === "allpass") ||
      (settings.rightMode === "independent" && settings.right.some((band) => band.type === "allpass"));
    if (allpass) {
      notes.push("Linear phase matches magnitude only, so allpass bands are not applied.");
    }
  }
  if (wav?.channels === 1 && settings.rightMode !== "copy") {
    notes.push("Mono input: the right curve is ignored and the left curve is applied.");
  }
  if (settings.format === "i16" || settings.format === "i24") {
    notes.push("Integer output dithers with TPDF and clips anything above 0 dBFS.");
  } else {
    notes.push("Float output keeps peaks above 0 dBFS. Nothing is normalized.");
  }
  const preampLeft = parsePreampNumber("left", settings.preampLeft, errors);
  const preampRight = parsePreampNumber("right", settings.preampRight, errors);
  if (preampLeft != null && preampRight != null && (preampLeft !== 0 || preampRight !== 0)) {
    notes.push("Preamp is a broadband gain after the filters, before dither and clipping.");
  }
  if (settings.rightMode === "bypass" && wav?.channels !== 1) {
    notes.push("An empty right list bypasses the right channel. Omitting it would copy the left curve.");
  }
  if (!nyquist && hasInput && !wav) {
    notes.push("Frequency is checked against Nyquist once the WAV header can be read.");
  }

  const outputName = sanitizeOutputName(settings.outputName);
  if (!outputName) errors.push("Output file name must be a single .wav name, with no folders or ..");

  let preset: Record<string, unknown> | null = null;
  if (left && preampLeft != null && preampRight != null && (settings.rightMode !== "independent" || right)) {
    preset = {
      linear_phase: settings.linearPhase,
      preamp_left: preampLeft,
      left: dotLevels(settings.left, left, rateForDots(sampleRate), library).map(bandJson),
    };
    const name = settings.name.trim();
    if (name) preset.name = name;
    if (settings.rightMode === "bypass") preset.right = [];
    if (settings.rightMode === "independent" && right) {
      preset.preamp_right = preampRight;
      preset.right = dotLevels(settings.right, right, rateForDots(sampleRate), library).map(bandJson);
    }
  }

  const shownIn = inputName || "input.wav";
  const shownOut = outputName ?? (settings.outputName.trim() || "output.wav");
  const eq = preset ? JSON.stringify(preset) : "{}";
  const command = `parametric-eq ${quote(shownIn)} ${quote(shownOut)} --format ${settings.format} --eq ${quote(eq)}`;
  return { errors, notes, command, preset };
}

export function parseEqSettings(raw: unknown): EqSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const format = FORMATS.find((item) => item.id === record.format)?.id;
  const rightMode = RIGHT_MODES.find((item) => item.id === record.rightMode)?.id;
  const left = parseDrafts(record.left);
  const right = parseDrafts(record.right);
  if (!format || !rightMode || !left || !right) return null;
  if (typeof record.name !== "string" || record.name.length > 200) return null;
  if (typeof record.linearPhase !== "boolean") return null;
  const preampLeft = parsePreampDraft(record.preampLeft);
  const preampRight = parsePreampDraft(record.preampRight);
  if (!preampLeft || !preampRight) return null;
  if (typeof record.outputName !== "string" || typeof record.overwrite !== "boolean") return null;
  return {
    name: record.name,
    linearPhase: record.linearPhase,
    preampLeft,
    preampRight,
    left,
    rightMode,
    right,
    format,
    outputName: record.outputName,
    overwrite: record.overwrite,
  };
}

function parsePreampDraft(raw: unknown): string | null {
  if (raw == null) return "0";
  if (typeof raw !== "string" || raw.length > 32) return null;
  return Number.isFinite(Number(raw)) ? raw : null;
}

function parsePreampNumber(channel: string, raw: string, errors: string[]): number | null {
  const db = Number(raw);
  if (!Number.isFinite(db)) {
    errors.push(`${channel} preamp must be a finite number of dB.`);
    return null;
  }
  if (db < -36 || db > 36) {
    errors.push(`${channel} preamp must be from -36 to +36 dB.`);
    return null;
  }
  return Math.round(db * 10) / 10;
}

export function suggestPreampDb(peakDb: number): number {
  if (!(peakDb > 0)) return 0;
  return -Math.min(36, Math.ceil((peakDb - 1e-9) * 10) / 10);
}

function parseDrafts(raw: unknown): BandDraft[] | null {
  if (!Array.isArray(raw) || raw.length > 64) return null;
  const bands: BandDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const band = item as Record<string, unknown>;
    const type = FILTERS.find((entry) => entry.id === band.type)?.id;
    if (!type || typeof band.freq !== "string" || typeof band.gain !== "string" || typeof band.q !== "string") {
      return null;
    }
    if (band.freq.length > 32 || band.gain.length > 32 || band.q.length > 32) return null;
    bands.push({ type, freq: band.freq, gain: band.gain, q: band.q });
  }
  return bands;
}

function parseChannel(
  channel: string,
  drafts: BandDraft[],
  nyquist: number | null,
  errors: string[],
  library: EqLibrary | null,
  sampleRate: number | null,
): ParsedBand[] | null {
  const parsed: ParsedBand[] = [];
  let ok = true;
  drafts.forEach((draft, index) => {
    const n = index + 1;
    const freq = Number(draft.freq);
    const gain = Number(draft.gain);
    const q = Number(draft.q);
    if (!Number.isFinite(freq) || !Number.isFinite(gain) || !Number.isFinite(q)) {
      errors.push(`${channel} band ${n}: frequency, gain, and Q must be finite numbers.`);
      ok = false;
      return;
    }
    parsed.push({ type: draft.type, freq, gain, q });
  });
  if (!ok) return null;
  if (library && sampleRate) {
    const message = library.designError(channel, parsed, sampleRate);
    if (message) {
      errors.push(message);
      return null;
    }
    return parsed;
  }
  drafts.forEach((draft, index) => {
    const band = parsed[index];
    if (!band) return;
    if (band.freq <= 0 || (nyquist != null && band.freq >= nyquist)) {
      const limit = nyquist == null ? "the sample rate is known" : `Nyquist (${nyquist} Hz)`;
      errors.push(
        `${channel} band ${index + 1} (${draft.type}): frequency ${band.freq} Hz must be greater than 0 and below ${limit}.`,
      );
      ok = false;
    }
    if (band.q <= 0) {
      errors.push(`${channel} band ${index + 1} (${draft.type}): Q must be > 0 (got ${band.q}).`);
      ok = false;
    }
  });
  return ok ? parsed : null;
}

function rateForDots(sampleRate: number | null): number {
  return sampleRate && sampleRate > 0 ? sampleRate : 48000;
}

function dotLevels(
  drafts: BandDraft[],
  parsed: ParsedBand[],
  sampleRate: number,
  library: EqLibrary | null,
): ParsedBand[] {
  if (!library) return parsed;
  const levels = responseCurve(
    drafts,
    parsed.map((band) => band.freq),
    sampleRate,
    library,
  );
  if (levels.length !== parsed.length) return parsed;
  return parsed.map((band, index) => {
    if (!gainMatters(band.type)) return band;
    const db = levels[index];
    if (!Number.isFinite(db)) return band;
    const rounded = Math.round(Math.min(36, Math.max(-36, db)) * 10) / 10;
    return { ...band, gain: rounded };
  });
}

function bandJson(band: ParsedBand): { freq: number; gain: number; q: number; type: FilterId } {
  return { freq: band.freq, gain: band.gain, q: band.q, type: band.type };
}

export function responseCurve(
  drafts: BandDraft[],
  freqs: number[],
  sampleRate: number,
  library: EqLibrary | null,
): number[] {
  if (!library || !(sampleRate > 0)) return freqs.map(() => 0);
  const nyquist = sampleRate / 2;
  const bands = [];
  for (const draft of drafts) {
    const freq = Number(draft.freq);
    const gain = Number(draft.gain);
    const q = Number(draft.q);
    if (!Number.isFinite(freq) || !Number.isFinite(gain) || !Number.isFinite(q)) continue;
    if (!(freq > 0) || freq >= nyquist || !(q > 0)) continue;
    bands.push({ type: draft.type, freq, gain, q });
  }
  const result = library.curveDb(bands, freqs, sampleRate);
  if (!Array.isArray(result) || result.length !== freqs.length) return freqs.map(() => 0);
  return result.map((db) => (Number.isFinite(db) ? db : -240));
}

export function responseDb(
  drafts: BandDraft[],
  hz: number,
  sampleRate: number,
  library: EqLibrary | null,
): number {
  return responseCurve(drafts, [hz], sampleRate, library)[0] ?? 0;
}

function quote(arg: string): string {
  if (/^[A-Za-z0-9_./:+-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}
