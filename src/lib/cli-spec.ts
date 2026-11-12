/** Shared contract for the wav-upsample CLI. Safe to import from the browser. */

export const RATES = [
  { hz: 44100, label: "44.1 kHz", arg: "44100" },
  { hz: 48000, label: "48 kHz", arg: "48000" },
  { hz: 96000, label: "96 kHz", arg: "96000" },
  { hz: 192000, label: "192 kHz", arg: "192000" },
] as const;

export const FILTERS = [
  {
    id: "kaiser",
    label: "Kaiser",
    detail: "Steepest stopband for the tap budget.",
  },
  {
    id: "gauss",
    label: "Gaussian",
    detail: "Less ringing, softer knee.",
  },
  {
    id: "blackman-harris",
    label: "Blackman–Harris",
    detail: "Sidelobe floor near −92 dB. Length still follows attenuation.",
  },
] as const;

export const PHASES = [
  {
    id: "linear",
    label: "Linear",
    detail: "Symmetric impulse. Equal pre- and post-ring.",
  },
  {
    id: "minimum",
    label: "Minimum",
    detail: "Same magnitude, no pre-ring. Post-ring stays.",
  },
] as const;

export const QUALITIES = [
  {
    id: "short",
    label: "Short",
    bandwidth: 0.9,
    atten: 100,
    detail: "90% of the lower Nyquist, 100 dB.",
  },
  {
    id: "high",
    label: "High",
    bandwidth: 0.955,
    atten: 140,
    detail: "95.5% of Nyquist, 140 dB. Default.",
  },
  {
    id: "extreme",
    label: "Extreme",
    bandwidth: 0.985,
    atten: 170,
    detail: "98.5% of Nyquist, 170 dB. Long kernel.",
  },
] as const;

export const DITHERS = [
  {
    id: "none",
    label: "None",
    detail: "Round to nearest. Fine for 24-bit, poor for 16-bit.",
  },
  {
    id: "tpdf",
    label: "TPDF",
    detail: "Triangular ±1 LSB. Correct at every rate.",
  },
  {
    id: "shaped",
    label: "Shaped",
    detail: "Wannamaker F-weight at 44.1 kHz. First-order elsewhere.",
  },
] as const;

export const THREAD_CHOICES = [0, 1, 2, 4, 8] as const;

export type RateHz = (typeof RATES)[number]["hz"];
export type FilterId = (typeof FILTERS)[number]["id"];
export type PhaseId = (typeof PHASES)[number]["id"];
export type QualityId = (typeof QUALITIES)[number]["id"];
export type DitherId = (typeof DITHERS)[number]["id"];
export type ThreadChoice = (typeof THREAD_CHOICES)[number];
export type RunMode = "convert" | "info";

export type BenchSettings = {
  mode: RunMode;
  rate: RateHz;
  bits: 16 | 24;
  filter: FilterId;
  phase: PhaseId;
  quality: QualityId;
  usePresetBandwidth: boolean;
  bandwidth: number;
  usePresetAtten: boolean;
  atten: number;
  dither: DitherId;
  headroom: number;
  threads: ThreadChoice;
  outputName: string;
  overwrite: boolean;
};

export const DEFAULT_SETTINGS: BenchSettings = {
  mode: "convert",
  rate: 96000,
  bits: 24,
  filter: "kaiser",
  phase: "linear",
  quality: "high",
  usePresetBandwidth: true,
  bandwidth: 0.955,
  usePresetAtten: true,
  atten: 140,
  dither: "tpdf",
  headroom: 0,
  threads: 0,
  outputName: "",
  overwrite: false,
};

export type WavFacts = {
  sampleRate: number;
  channels: number;
  bits: number;
  kind: "int" | "float";
  frames: number | null;
};

const BANDWIDTH_MIN = 0.5;
const BANDWIDTH_MAX = 0.995;
const ATTEN_MIN = 40;
const ATTEN_MAX = 200;
const HEADROOM_MAX = 12;
const MAX_TAPS = 4095;
const MAX_PROTOTYPE = 3_000_000;
const MAX_RATIO = 8192;

export function qualityOf(id: QualityId) {
  const found = QUALITIES.find((q) => q.id === id);
  if (!found) throw new Error(`unknown quality ${id}`);
  return found;
}

export function effectiveBandwidth(s: BenchSettings): number {
  return s.usePresetBandwidth ? qualityOf(s.quality).bandwidth : s.bandwidth;
}

export function effectiveAtten(s: BenchSettings): number {
  return s.usePresetAtten ? qualityOf(s.quality).atten : s.atten;
}

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return Math.max(1, x);
}

/** Same refusal rules as design_prototype in wav-upsample. */
export function estimateKernel(
  fsIn: number,
  fsOut: number,
  bandwidth: number,
  attenDb: number,
): { taps: number; prototype: number; l: number; m: number; error: string | null } {
  const g = gcd(fsIn, fsOut);
  const l = fsOut / g;
  const m = fsIn / g;
  if (l > MAX_RATIO || m > MAX_RATIO) {
    return {
      taps: 0,
      prototype: 0,
      l,
      m,
      error: `Ratio ${l}/${m} is too large. This tool targets the 44.1/48 family.`,
    };
  }
  const limitHz = Math.min(fsIn, fsOut) * 0.5;
  const transitionHz = Math.max(limitHz - limitHz * bandwidth, 1);
  const deltaOmega = 2 * Math.PI * (transitionHz / fsIn);
  const nEst = (attenDb - 8) / (2.285 * deltaOmega);
  let taps = Math.max(15, Math.ceil(nEst));
  if (taps % 2 === 0) taps += 1;
  if (taps > MAX_TAPS) {
    const passband = limitHz * bandwidth;
    return {
      taps,
      prototype: 0,
      l,
      m,
      error: `This setting wants ${taps} taps per output sample (passband ${passband.toFixed(1)} Hz, ${transitionHz.toFixed(0)} Hz transition, ${attenDb.toFixed(0)} dB). Lower attenuation or widen the transition.`,
    };
  }
  const prototype = taps * l;
  if (prototype > MAX_PROTOTYPE) {
    return {
      taps,
      prototype,
      l,
      m,
      error: `Prototype length ${prototype} is too large. Use a shorter quality preset.`,
    };
  }
  return { taps, prototype, l, m, error: null };
}

const NAME_RE = /^[\w .()-]{1,120}$/;

export function sanitizeOutputName(name: string): string | null {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) return null;
  if (trimmed.includes("..") || trimmed.startsWith(".")) return null;
  if (!trimmed.toLowerCase().endsWith(".wav")) return null;
  return trimmed;
}

export function suggestOutputName(inputName: string, rate: RateHz): string {
  const stem = inputName.replace(/\.wav$/i, "").replace(/[^\w .()-]+/g, "").trim() || "output";
  const tag = RATES.find((r) => r.hz === rate)?.label.replace(" kHz", "k").replace(".", "") ?? String(rate);
  const next = `${stem}-${tag}.wav`;
  return sanitizeOutputName(next) ?? "output.wav";
}

export type Assessment = {
  errors: string[];
  notes: string[];
  resampling: boolean;
  taps: number | null;
  command: string;
};

export function assess(
  settings: BenchSettings,
  wav: WavFacts | null,
  hasInput: boolean,
  inputLabel = "input.wav",
): Assessment {
  const errors: string[] = [];
  const notes: string[] = [];
  if (!hasInput) errors.push("Choose an input WAV.");
  if (wav && wav.sampleRate < 1000) {
    errors.push(`Input rate ${wav.sampleRate} Hz is below the 1000 Hz minimum.`);
  }

  const bandwidth = effectiveBandwidth(settings);
  const atten = effectiveAtten(settings);
  if (!settings.usePresetBandwidth && (bandwidth < BANDWIDTH_MIN || bandwidth > BANDWIDTH_MAX)) {
    errors.push("Bandwidth must be between 0.50 and 0.995.");
  }
  if (!settings.usePresetAtten && (atten < ATTEN_MIN || atten > ATTEN_MAX)) {
    errors.push("Attenuation must be between 40 and 200 dB.");
  }
  if (settings.headroom < 0 || settings.headroom > HEADROOM_MAX) {
    errors.push(`Headroom must be between 0 and ${HEADROOM_MAX} dB.`);
  }
  if (!THREAD_CHOICES.includes(settings.threads)) {
    errors.push("Thread count is not one of the allowed choices.");
  }

  const sameRate = wav != null && wav.sampleRate === settings.rate;
  const resampling = wav != null && !sameRate;
  let taps: number | null = null;

  if (resampling && wav) {
    const kernel = estimateKernel(wav.sampleRate, settings.rate, bandwidth, atten);
    taps = kernel.taps;
    if (kernel.error) errors.push(kernel.error);
  }

  if (settings.mode === "convert") {
    if (!sanitizeOutputName(settings.outputName)) {
      errors.push("Output file name must be a single .wav name, with no folders or ..");
    }
  }

  if (sameRate) {
    notes.push("Input and output rates match. The resampler is skipped; only bit depth, dither and headroom apply.");
  }
  if (settings.mode === "info") {
    notes.push("Inspect prints the filter and does not write audio. Output name and overwrite are unused.");
  }
  if (resampling && settings.filter === "blackman-harris" && atten > 92) {
    notes.push("Blackman–Harris will not reach this attenuation. The number still sets how long the kernel is.");
  }
  if (resampling && settings.filter === "gauss") {
    notes.push("Gaussian will not hit the Kaiser attenuation figure. It still sets the kernel length.");
  }
  if (settings.dither === "shaped" && settings.rate !== 44100) {
    notes.push("Shaped dither is the F-weight curve only at 44.1 kHz. Here it is a short first-order highpass.");
  }
  if (settings.dither === "none" && settings.bits === 16) {
    notes.push("No dither at 16-bit leaves the quantization error correlated with the signal.");
  }
  if (resampling && settings.phase === "minimum" && (settings.quality === "extreme" || atten >= 170)) {
    notes.push("Minimum phase at this length runs a multi-million-point FFT before any audio is written.");
  }
  if (settings.mode === "convert" && !settings.overwrite) {
    notes.push("Overwrite is off. An existing destination with this file name is refused.");
  }

  return {
    errors,
    notes,
    resampling,
    taps,
    command: formatCommand(settings, wav, inputLabel),
  };
}

export function formatCommand(
  settings: BenchSettings,
  wav: WavFacts | null,
  inputLabel = "input.wav",
): string {
  const parts = ["wav-upsample", "-i", inputLabel, "-r", String(settings.rate), "-b", String(settings.bits)];
  const sameRate = wav != null && wav.sampleRate === settings.rate;
  if (!sameRate) {
    parts.push("--filter", settings.filter, "--phase", settings.phase, "--quality", settings.quality);
    if (!settings.usePresetBandwidth) parts.push("--bandwidth", trimNum(effectiveBandwidth(settings)));
    if (!settings.usePresetAtten) parts.push("--atten", trimNum(effectiveAtten(settings)));
  }
  parts.push("--dither", settings.dither);
  if (settings.headroom !== 0) parts.push("--headroom", trimNum(settings.headroom));
  if (settings.threads !== 0) parts.push("-j", String(settings.threads));
  if (settings.mode === "info") {
    parts.push("--info");
  } else {
    const name = sanitizeOutputName(settings.outputName) ?? "output.wav";
    parts.push("-o", name);
  }
  return parts.map(quoteArg).join(" ");
}

/** Argv for spawn. Paths are the real files. Null when the settings are illegal. */
export function buildArgv(
  settings: BenchSettings,
  wav: WavFacts | null,
  inputPath: string,
  outputPath: string | null,
): string[] | null {
  if (assess(settings, wav, true).errors.length > 0) return null;
  const sameRate = wav != null && wav.sampleRate === settings.rate;
  const args = ["-i", inputPath, "-r", String(settings.rate), "-b", String(settings.bits)];
  if (!sameRate) {
    args.push("--filter", settings.filter, "--phase", settings.phase, "--quality", settings.quality);
    if (!settings.usePresetBandwidth) args.push("--bandwidth", trimNum(effectiveBandwidth(settings)));
    if (!settings.usePresetAtten) args.push("--atten", trimNum(effectiveAtten(settings)));
  }
  args.push("--dither", settings.dither);
  if (settings.headroom !== 0) args.push("--headroom", trimNum(settings.headroom));
  if (settings.threads !== 0) args.push("-j", String(settings.threads));
  if (settings.mode === "info") {
    args.push("--info");
  } else if (outputPath) {
    args.push("-o", outputPath);
  } else {
    return null;
  }
  return args;
}

function trimNum(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function parseSettings(raw: unknown): BenchSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode === "info" ? "info" : r.mode === "convert" ? "convert" : null;
  const rate = RATES.find((item) => item.hz === r.rate)?.hz ?? null;
  const bits = r.bits === 16 || r.bits === 24 ? r.bits : null;
  const filter = FILTERS.find((item) => item.id === r.filter)?.id ?? null;
  const phase = PHASES.find((item) => item.id === r.phase)?.id ?? null;
  const quality = QUALITIES.find((item) => item.id === r.quality)?.id ?? null;
  const dither = DITHERS.find((item) => item.id === r.dither)?.id ?? null;
  const threads = THREAD_CHOICES.find((item) => item === r.threads);
  if (!mode || !rate || !bits || !filter || !phase || !quality || !dither || threads === undefined) {
    return null;
  }
  if (typeof r.bandwidth !== "number" || typeof r.atten !== "number" || typeof r.headroom !== "number") {
    return null;
  }
  if (typeof r.outputName !== "string" || typeof r.overwrite !== "boolean") return null;
  if (typeof r.usePresetBandwidth !== "boolean" || typeof r.usePresetAtten !== "boolean") return null;
  return {
    mode,
    rate,
    bits,
    filter,
    phase,
    quality,
    usePresetBandwidth: r.usePresetBandwidth,
    bandwidth: r.bandwidth,
    usePresetAtten: r.usePresetAtten,
    atten: r.atten,
    dither,
    headroom: r.headroom,
    threads,
    outputName: r.outputName,
    overwrite: r.overwrite,
  };
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}
function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Reads the fmt/data chunks. Returns an error string or the facts. */
export async function readWavFacts(file: Blob): Promise<WavFacts | { error: string }> {
  const buf = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
  if (buf.byteLength < 44) return { error: "File is too small to be a WAV." };
  const view = new DataView(buf);
  const tag = (offset: number, len: number) => String.fromCharCode(...new Uint8Array(buf, offset, len));
  if (tag(0, 4) !== "RIFF" || tag(8, 4) !== "WAVE") return { error: "Not a RIFF WAVE file." };
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let kind: "int" | "float" | null = null;
  let blockAlign = 0;
  let dataBytes: number | null = null;
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset, 4);
    const size = u32(view, offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      if (start + 16 > view.byteLength) return { error: "WAV fmt chunk is truncated." };
      const format = u16(view, start);
      channels = u16(view, start + 2);
      sampleRate = u32(view, start + 4);
      blockAlign = u16(view, start + 12);
      bits = u16(view, start + 14);
      if (format === 3) kind = "float";
      else if (format === 1) kind = "int";
      else if (format === 0xfffe && start + 40 <= view.byteLength) {
        const sub = u16(view, start + 24);
        kind = sub === 3 ? "float" : "int";
        if (bits === 0) bits = u16(view, start + 18);
      } else {
        return { error: `Unsupported WAV format tag ${format}.` };
      }
    } else if (id === "data") {
      dataBytes = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!kind || !sampleRate || !channels) return { error: "WAV is missing a usable fmt chunk." };
  const frames = dataBytes != null && blockAlign > 0 ? Math.floor(dataBytes / blockAlign) : null;
  return { sampleRate, channels, bits, kind, frames };
}
