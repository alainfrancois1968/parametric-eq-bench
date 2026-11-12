import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Play, Plus, SquareTerminal, Trash2 } from "lucide-react";

import { fitDrawnCurve, type DrawPoint } from "@/lib/fit-curve";
import { readWavFacts, type WavFacts } from "@/lib/cli-spec";
import {
  DEFAULT_SETTINGS,
  FILTERS,
  FORMATS,
  RIGHT_MODES,
  assessEq,
  gainMatters,
  responseCurve,
  suggestEqName,
  suggestPreampDb,
  type BandDraft,
  type EqLibrary,
  type EqSettings,
  type FilterId,
  type FormatId,
  type RightMode,
} from "@/lib/eq-spec";

type Folder = {
  name: string;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
  }>;
};

type RunEvent =
  | { type: "log"; text: string }
  | { type: "error"; text: string }
  | { type: "done"; mode: "convert"; id: string; filename: string };

function canPickFolder(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

async function pickFolder(): Promise<Folder | null> {
  const picker = (window as Window & { showDirectoryPicker?: (opts: { mode: "readwrite" }) => Promise<Folder> })
    .showDirectoryPicker;
  if (!picker) return null;
  return picker({ mode: "readwrite" });
}

async function folderHas(folder: Folder, name: string): Promise<boolean> {
  try {
    await folder.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export function EqBench() {
  const [settings, setSettings] = useState<EqSettings>(DEFAULT_SETTINGS);
  const [file, setFile] = useState<File | null>(null);
  const [wav, setWav] = useState<WavFacts | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const [cliReady, setCliReady] = useState<boolean | null>(null);
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("Ready.\n");
  const [zipHref, setZipHref] = useState("/parametric-eq-bench-1.0.18.zip");
  const [zipNote, setZipNote] = useState<string | null>(null);
  const [library, setLibrary] = useState<EqLibrary | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/eq")
      .then((res) => res.json())
      .then((body: { ready?: boolean; version?: string | null }) => {
        if (cancelled) return;
        setCliReady(Boolean(body.ready));
        setCliVersion(body.version ?? null);
      })
      .catch(() => {
        if (!cancelled) setCliReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const prefix = window.location.pathname.match(/^\/hds-[a-z0-9]+-\d+-[a-z0-9]+/i)?.[0] ?? "";
    setZipHref(`${prefix}/parametric-eq-bench-1.0.18.zip`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void import("@/lib/eq-core.client").then((mod) => {
      if (!cancelled) setLibrary(mod.browserEqLibrary());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, running]);

  const verdict = useMemo(
    () => assessEq(settings, wav, file != null, file?.name ?? "input.wav", library),
    [settings, wav, file, library],
  );
  const blocked = verdict.errors.length > 0 || running || cliReady === false;
  const nyquist = wav && wav.sampleRate > 0 ? wav.sampleRate / 2 : null;

  function patch(partial: Partial<EqSettings>) {
    setSettings((current) => ({ ...current, ...partial }));
  }

  function patchBand(channel: "left" | "right", index: number, partial: Partial<BandDraft>) {
    setSettings((current) => {
      const next = current[channel].map((band, i) => (i === index ? { ...band, ...partial } : band));
      return { ...current, [channel]: next };
    });
  }

  function addBand(channel: "left" | "right") {
    addBandAt(channel, "1000", "0");
  }

  function addBandAt(channel: "left" | "right", freq: string, gain: string) {
    const fresh: BandDraft = { type: "peak", freq, gain, q: "1" };
    setSettings((current) => ({ ...current, [channel]: [...current[channel], fresh] }));
  }

  function replaceBands(channel: "left" | "right", bands: BandDraft[]) {
    setSettings((current) => ({ ...current, [channel]: bands }));
  }

  function removeBand(channel: "left" | "right", index: number) {
    setSettings((current) => ({
      ...current,
      [channel]: current[channel].filter((_, i) => i !== index),
    }));
  }

  async function onFile(next: File | null) {
    setFile(next);
    setWav(null);
    setFileError(null);
    if (!next) return;
    const facts = await readWavFacts(next);
    if ("error" in facts) {
      setFileError(facts.error);
      return;
    }
    setWav(facts);
    if (!nameTouched) patchName(suggestEqName(next.name));
  }

  function patchName(outputName: string) {
    setSettings((current) => ({ ...current, outputName }));
  }

  async function onBrowseFolder() {
    setFolderNote(null);
    if (!canPickFolder()) {
      setFolderNote("This browser will download the WAV instead of writing a folder.");
      return;
    }
    try {
      const picked = await pickFolder();
      if (picked) setFolder(picked);
    } catch {
      setFolderNote("Folder choice was cancelled.");
    }
  }

  async function onExecute() {
    if (!file || blocked) return;
    const name = settings.outputName.trim();
    if (folder && name && !settings.overwrite) {
      const exists = await folderHas(folder, name);
      if (exists) {
        setLog(
          `$ ${verdict.command}\nrefusing to overwrite ${folder.name}/${name}\noverwrite is off — turn it on to replace the existing destination\n`,
        );
        return;
      }
    }

    setRunning(true);
    setLog("");
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("settings", JSON.stringify(settings));
      const response = await fetch("/api/eq", { method: "POST", body });
      if (!response.ok || !response.body) {
        setLog(`Request failed (${response.status}).\n`);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let download: { id: string; filename: string } | null = null;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        pending += decoder.decode(step.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as RunEvent;
          if (event.type === "log") setLog((current) => current + event.text);
          else if (event.type === "error") {
            setLog((current) => `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${event.text}\n`);
          } else if (event.type === "done") download = { id: event.id, filename: event.filename };
        }
      }
      if (download) {
        const fileResponse = await fetch(`/api/eq-result/${download.id}`);
        if (!fileResponse.ok) {
          setLog((current) => `${current}could not read the rendered WAV\n`);
          return;
        }
        const blob = await fileResponse.blob();
        if (folder) {
          const handle = await folder.getFileHandle(download.filename, { create: true });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          setLog((current) => `${current}saved: ${folder.name}/${download.filename}\n`);
        } else {
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = download.filename;
          anchor.click();
          URL.revokeObjectURL(url);
          setLog((current) => `${current}download: ${download.filename}\n`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Run failed.";
      setLog((current) => `${current}${message}\n`);
    } finally {
      setRunning(false);
    }
  }

  const duration =
    wav && wav.frames != null && wav.sampleRate > 0 ? `${(wav.frames / wav.sampleRate).toFixed(2)} s` : null;

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-accent">bench 1.0.18</p>
        <h1 className="text-3xl font-semibold tracking-tight">Parametric EQ</h1>
        <p className="max-w-2xl text-base text-muted">
          Pick a WAV and shape left and right separately. A choice the CLI would reject stays disabled, and Execute
          stays off until the curve is legal.
        </p>
        <p className="text-sm text-muted">
          {cliReady == null ? "Checking the CLI…" : cliReady ? `CLI ${cliVersion ?? "ready"}` : "CLI unavailable"}
        </p>
        <a
          href={zipHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() =>
            setZipNote(
              "Opening parametric-eq-bench.zip in a new tab. If nothing saves, this preview is blocking the file.",
            )
          }
          className="inline-flex min-h-11 w-fit items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-ink"
        >
          Download parametric-eq-bench 1.0.18.zip
        </a>
        {zipNote ? <p className="text-sm text-muted">{zipNote}</p> : null}
      </header>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
          <label className="flex flex-col gap-2 text-sm font-medium">
            Input WAV
            <input
              type="file"
              accept=".wav,audio/wav,audio/x-wav"
              disabled={running}
              onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
              className="min-h-11 text-sm file:mr-3 file:min-h-9 file:rounded-md file:border-0 file:bg-accent file:px-3 file:font-medium file:text-accent-ink"
            />
          </label>
          <p className="text-sm text-muted">
            {fileError
              ? fileError
              : wav
                ? `${wav.sampleRate} Hz · ${wav.channels === 1 ? "mono" : wav.channels === 2 ? "stereo" : `${wav.channels} ch`} · ${wav.bits}-bit ${wav.kind}${duration ? ` · ${duration}` : ""}${nyquist ? ` · Nyquist ${nyquist} Hz` : ""}`
                : "PCM 16/24/32 or float 32/64. Mono and stereo only."}
          </p>
          <label className="flex flex-col gap-2 text-sm font-medium">
            Preset name
            <input
              value={settings.name}
              disabled={running}
              onChange={(event) => patch({ name: event.target.value })}
              className="min-h-11 rounded-md border border-line bg-bg px-3 font-mono text-sm text-fg"
            />
          </label>
          <p className="text-sm text-muted">A label only. It is printed in the CLI report and does not change the filters.</p>
        </div>

        <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
          <label className="flex flex-col gap-2 text-sm font-medium">
            Output file name
            <input
              value={settings.outputName}
              disabled={running}
              onChange={(event) => {
                setNameTouched(true);
                patchName(event.target.value);
              }}
              className="min-h-11 rounded-md border border-line bg-bg px-3 font-mono text-sm text-fg"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void onBrowseFolder()}
              disabled={running}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-bg px-3 text-sm font-medium"
            >
              <FolderOpen className="size-4" aria-hidden />
              {folder ? folder.name : "Output folder"}
            </button>
            <label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={settings.overwrite}
                disabled={running}
                onChange={(event) => patch({ overwrite: event.target.checked })}
                className="size-5 accent-accent"
              />
              Overwrite destination
            </label>
          </div>
          <p className="text-sm text-muted">
            {folder
              ? `Writes ${settings.outputName || "the WAV"} into ${folder.name} when the browser allows it.`
              : "No folder yet. The rendered WAV downloads in the browser."}
            {folderNote ? ` ${folderNote}` : ""}
          </p>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Choice
          legend="Phase"
          value={settings.linearPhase ? "linear" : "minimum"}
          disabled={running}
          onChange={(value) => patch({ linearPhase: value === "linear" })}
          options={[
            { id: "minimum", label: "Minimum phase", detail: "Cascaded biquads. No pre-ringing." },
            { id: "linear", label: "Linear phase", detail: "Zero-phase FIR matched to the same magnitude. Delay is removed." },
          ]}
        />
        <Choice
          legend="Output format"
          value={settings.format}
          disabled={running}
          onChange={(value) => patch({ format: value as FormatId })}
          options={FORMATS.map((item) => ({ id: item.id, label: item.label, detail: item.detail }))}
        />
      </section>

      <EqEditor
        title="Left channel"
        tone="left"
        bands={settings.left}
        sampleRate={wav?.sampleRate ?? 48000}
        assumedRate={wav == null}
        disabled={running}
        onAdd={() => addBand("left")}
        onAddAt={(freq, gain) => addBandAt("left", freq, gain)}
        onRemove={(index) => removeBand("left", index)}
        onChange={(index, partial) => patchBand("left", index, partial)}
        onReplace={(bands) => replaceBands("left", bands)}
        preamp={settings.preampLeft}
        onPreamp={(preampLeft) => patch({ preampLeft })}
        library={library}
      />

      <section className="flex flex-col gap-4">
        <Choice
          legend="Right channel"
          value={settings.rightMode}
          disabled={running}
          onChange={(value) => {
            const rightMode = value as RightMode;
            setSettings((current) => ({
              ...current,
              rightMode,
              preampRight:
                rightMode === "independent" && current.rightMode === "copy" ? current.preampLeft : current.preampRight,
              right:
                rightMode === "independent" && current.rightMode === "copy"
                  ? current.left.map((band) => ({ ...band }))
                  : current.right,
            }));
          }}
          options={RIGHT_MODES.map((item) => ({ id: item.id, label: item.label, detail: item.detail }))}
        />
        <button
          type="button"
          disabled={running}
          onClick={() => {
            setSettings((current) => ({
              ...current,
              rightMode: "independent",
              preampRight: current.preampLeft,
              right: current.left.map((band) => ({ ...band })),
            }));
          }}
          className="inline-flex min-h-11 items-center self-start rounded-md border border-line bg-surface px-3 text-sm font-medium"
        >
          Set both curves to the same shape
        </button>
        {settings.rightMode === "independent" ? (
          <EqEditor
            title="Right channel"
            tone="right"
            bands={settings.right}
            sampleRate={wav?.sampleRate ?? 48000}
        assumedRate={wav == null}
            disabled={running}
            onAdd={() => addBand("right")}
            onAddAt={(freq, gain) => addBandAt("right", freq, gain)}
            onRemove={(index) => removeBand("right", index)}
            onChange={(index, partial) => patchBand("right", index, partial)}
            onReplace={(bands) => replaceBands("right", bands)}
            preamp={settings.preampRight}
            onPreamp={(preampRight) => patch({ preampRight })}
            library={library}
          />
        ) : (
          <EqEditor
            title="Right channel"
            tone="right"
            bands={settings.rightMode === "copy" ? settings.left : []}
            sampleRate={wav?.sampleRate ?? 48000}
        assumedRate={wav == null}
            disabled
            readOnly
            note={
              settings.rightMode === "copy"
                ? "Same curve as the left channel. Change the left graph to move both."
                : "Right channel is bypassed. The curve is a flat 0 dB line."
            }
            onAdd={() => undefined}
            onAddAt={() => undefined}
            onRemove={() => undefined}
            onChange={() => undefined}
            preamp={settings.rightMode === "copy" ? settings.preampLeft : "0"}
            onPreamp={() => undefined}
            library={library}
          />
        )}
      </section>

      {verdict.errors.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-lg border border-accent bg-surface px-4 py-3 text-sm text-accent">
          {verdict.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      {verdict.notes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-muted">
          {verdict.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <SquareTerminal className="size-4 text-accent" aria-hidden />
          Command
        </div>
        <pre className="overflow-x-auto rounded-lg border border-line bg-bg p-4 font-mono text-sm text-muted">
          {verdict.command}
        </pre>
        <button
          type="button"
          onClick={() => void onExecute()}
          disabled={blocked || !file}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-5 font-medium text-accent-ink disabled:opacity-40"
        >
          <Play className="size-4" aria-hidden />
          {running ? "Running…" : "Execute"}
        </button>
        <pre
          ref={logRef}
          role="log"
          aria-readonly="true"
          aria-label="CLI output"
          className="max-h-96 min-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-4 font-mono text-sm text-fg"
        >
          {log}
        </pre>
      </section>
    </main>
  );
}

function EqEditor({
  title,
  tone,
  bands,
  sampleRate,
  assumedRate,
  disabled,
  readOnly,
  note,
  onAdd,
  onAddAt,
  onRemove,
  onChange,
  onReplace,
  preamp,
  onPreamp,
  library,
}: {
  title: string;
  tone: "left" | "right";
  bands: BandDraft[];
  sampleRate: number;
  assumedRate?: boolean;
  disabled: boolean;
  readOnly?: boolean;
  note?: string;
  onAdd: () => void;
  onAddAt: (freq: string, gain: string) => void;
  onRemove: (index: number) => void;
  onChange: (index: number, partial: Partial<BandDraft>) => void;
  onReplace?: (bands: BandDraft[]) => void;
  preamp: string;
  onPreamp: (value: string) => void;
  library: EqLibrary | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<number | null>(null);
  const dragOrigin = useRef<{ pointerDb: number; dotDb: number; dbMin: number; dbMax: number } | null>(null);
  const drawingRef = useRef(false);
  const liveRef = useRef<DrawPoint[]>([]);
  const moveDragRef = useRef<(x: number, y: number) => void>(() => undefined);
  const endDragRef = useRef<() => void>(() => undefined);
  const [selected, setSelected] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [guideId, setGuideId] = useState("none");
  const [drawMode, setDrawMode] = useState(false);
  const [sketch, setSketch] = useState<DrawPoint[] | null>(null);
  const [liveSketch, setLiveSketch] = useState<DrawPoint[] | null>(null);
  const prevCount = useRef(bands.length);
  const stroke = tone === "left" ? "#e0a045" : "#7eb6d6";
  const nyquist = sampleRate > 0 ? sampleRate / 2 : 24000;
  const fMin = 20;
  const fMax = Math.max(nyquist, fMin * 2);

  useEffect(() => {
    if (bands.length > prevCount.current) setSelected(bands.length - 1);
    else if (selected >= bands.length) setSelected(Math.max(0, bands.length - 1));
    prevCount.current = bands.length;
  }, [bands.length, selected]);

  const preampDb = Number(preamp);
  const preampOffset = Number.isFinite(preampDb) ? preampDb : 0;
  const plot = useMemo(
    () => buildPlot(bands, sampleRate, fMin, fMax, library, drawMode, sketch, preampOffset),
    [bands, sampleRate, fMin, fMax, library, drawMode, sketch, preampOffset],
  );
  const bandOrder = useMemo(() => orderBands(bands), [bands]);
  const numberOf = useMemo(() => new Map(bandOrder.map((item) => [item.index, item.number])), [bandOrder]);
  const guide = GUIDES.find((item) => item.id === guideId) ?? null;
  const predominant = guide ? Math.sqrt(guide.peakLow * guide.peakHigh) : 0;

  function pointFrom(clientX: number, clientY: number): { x: number; y: number } | null {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const mapped = point.matrixTransform(matrix.inverse());
    return { x: mapped.x, y: mapped.y };
  }

  function drawPoint(clientX: number, clientY: number): DrawPoint | null {
    const point = pointFrom(clientX, clientY);
    if (!point) return null;
    const freq = clamp(freqFromX(point.x, fMin, fMax), fMin, Math.min(fMax * 0.999, nyquist * 0.999));
    const db = clamp(dbFromY(point.y, plot.dbMin, plot.dbMax), -36, 36);
    return { hz: freq, db };
  }

  function startDraw(clientX: number, clientY: number) {
    const point = drawPoint(clientX, clientY);
    if (!point) return;
    drawingRef.current = true;
    liveRef.current = [point];
    setLiveSketch(liveRef.current);
  }

  function extendDraw(clientX: number, clientY: number) {
    if (!drawingRef.current) return;
    const point = drawPoint(clientX, clientY);
    if (!point) return;
    const previous = liveRef.current[liveRef.current.length - 1];
    if (previous && Math.abs(Math.log2(point.hz / previous.hz)) < 0.002 && Math.abs(point.db - previous.db) < 0.15) return;
    liveRef.current = [...liveRef.current, point];
    setLiveSketch(liveRef.current);
  }

  function finishDraw() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const stroke = liveRef.current;
    liveRef.current = [];
    setLiveSketch(null);
    if (stroke.length < 4) return;
    setSketch(stroke);
    const fitted = fitDrawnCurve(stroke, sampleRate, library);
    if (fitted.length && onReplace) onReplace(fitted);
  }

  function moveDrag(clientX: number, clientY: number) {
    const index = dragRef.current;
    if (index == null || readOnly) return;
    const point = pointFrom(clientX, clientY);
    const band = bands[index];
    const origin = dragOrigin.current;
    if (!point || !band || !origin) return;
    const x = clamp(point.x, PAD_L, PLOT_W - PAD_R);
    const y = clamp(point.y, PAD_T, PLOT_H - PAD_B);
    const freq = clamp(freqFromX(x, fMin, fMax), fMin, Math.min(fMax * 0.999, nyquist * 0.999));
    const next: Partial<BandDraft> = { freq: formatFreq(freq) };
    if (gainMatters(band.type)) {
      const pointerDb = dbFromY(y, origin.dbMin, origin.dbMax);
      next.gain = formatDb(clamp(origin.dotDb + (pointerDb - origin.pointerDb), -36, 36));
    }
    onChange(index, next);
  }

  function endDrag() {
    dragRef.current = null;
    dragOrigin.current = null;
    setDragIndex(null);
  }

  moveDragRef.current = moveDrag;
  endDragRef.current = endDrag;

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (dragRef.current == null) return;
      moveDragRef.current(event.clientX, event.clientY);
    };
    const onUp = () => {
      if (dragRef.current == null) return;
      endDragRef.current();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <section className="flex min-w-0 max-w-full flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2 className="text-sm font-medium">{title}</h2>
          <select
            aria-label={`${title} frequency guide`}
            value={guideId}
            onChange={(event) => setGuideId(event.target.value)}
            className="min-h-11 max-w-full rounded-md border border-line bg-bg px-2 text-sm text-fg"
          >
            <option value="none">No frequency guide</option>
            {GUIDE_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {GUIDES.filter((item) => item.group === group).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Preamp</span>
            <input
              aria-label={`${title} preamp`}
              type="number"
              inputMode="decimal"
              min={-36}
              max={36}
              step="0.1"
              value={preamp}
              disabled={disabled || readOnly}
              onChange={(event) => onPreamp(event.target.value)}
              className="min-h-11 w-24 rounded-md border border-line bg-bg px-2 font-mono text-sm text-fg disabled:opacity-60"
            />
            <span className="text-muted">dB</span>
          </label>
          {readOnly ? null : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPreamp(formatDb(suggestPreampDb(plot.filterPeak)))}
              className="inline-flex min-h-11 items-center rounded-md border border-line bg-bg px-3 text-sm font-medium"
            >
              Suggest
            </button>
          )}
        </div>
        {readOnly ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={drawMode}
              onClick={() => setDrawMode((current) => !current)}
              disabled={disabled}
              className={`inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium ${drawMode ? "border-accent bg-accent text-accent-ink" : "border-line bg-bg"}`}
            >
              {drawMode ? "Drawing" : "Draw curve"}
            </button>
            <button
              type="button"
              onClick={onAdd}
              disabled={disabled}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-bg px-3 text-sm font-medium"
            >
              <Plus className="size-4" aria-hidden />
              Add band
            </button>
          </div>
        )}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        role="img"
        aria-label={`${title} frequency response`}
        className={`w-full touch-none rounded-md bg-bg ${drawMode ? "cursor-crosshair" : ""}`}
        onPointerDown={(event) => {
          if (!drawMode || disabled || readOnly) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          startDraw(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!drawMode) return;
          extendDraw(event.clientX, event.clientY);
        }}
        onPointerUp={() => finishDraw()}
        onPointerCancel={() => finishDraw()}
        onDoubleClick={(event) => {
          if (drawMode || disabled || readOnly) return;
          if ((event.target as Element).closest("[data-handle]")) return;
          const point = pointFrom(event.clientX, event.clientY);
          if (!point) return;
          const freq = clamp(freqFromX(point.x, fMin, fMax), fMin, Math.min(fMax * 0.999, nyquist * 0.999));
          const gain = clamp(dbFromY(point.y, plot.dbMin, plot.dbMax), -36, 36);
          onAddAt(formatFreq(freq), formatDb(gain));
        }}
      >
        {guide ? (
          <>
            <defs>
              <linearGradient
                id={`freq-guide-${tone}`}
                x1={PAD_L}
                y1="0"
                x2={PLOT_W - PAD_R}
                y2="0"
                gradientUnits="userSpaceOnUse"
              >
                {guideStops(guide, fMin, fMax).map((stop) => (
                  <stop key={stop.offset} offset={stop.offset} stopColor={stroke} stopOpacity={stop.opacity} />
                ))}
              </linearGradient>
            </defs>
            <rect
              x={PAD_L}
              y={PAD_T}
              width={PLOT_W - PAD_L - PAD_R}
              height={PLOT_H - PAD_T - PAD_B}
              fill={`url(#freq-guide-${tone})`}
              pointerEvents="none"
            />
          </>
        ) : null}
        {plot.grid.map((line) => (
          <g key={line.key}>
            <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="#3c362d" strokeWidth="1" />
            {line.label ? (
              <text x={line.labelX} y={line.labelY} fill="#a89f90" fontSize="11" fontFamily="IBM Plex Mono, monospace">
                {line.label}
              </text>
            ) : null}
          </g>
        ))}
        <line
          x1={PAD_L}
          y1={yFromDb(0, plot.dbMin, plot.dbMax)}
          x2={PLOT_W - PAD_R}
          y2={yFromDb(0, plot.dbMin, plot.dbMax)}
          stroke="#a89f90"
          strokeDasharray="4 4"
          strokeWidth="1"
        />
        <path key={plot.key} d={plot.d} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" />
        {sketch ? (
          <path
            d={sketchPath(sketch, fMin, fMax, plot.dbMin, plot.dbMax)}
            fill="none"
            stroke="#f3efe6"
            strokeWidth="1.5"
            strokeDasharray="5 4"
            pointerEvents="none"
          />
        ) : null}
        {liveSketch ? (
          <path
            d={sketchPath(liveSketch, fMin, fMax, plot.dbMin, plot.dbMax)}
            fill="none"
            stroke="#f3efe6"
            strokeWidth="1.75"
            pointerEvents="none"
          />
        ) : null}
        {guide && predominant >= fMin && predominant <= fMax ? (
          <line
            x1={xFromFreq(predominant, fMin, fMax)}
            y1={PAD_T}
            x2={xFromFreq(predominant, fMin, fMax)}
            y2={PLOT_H - PAD_B}
            stroke="#e23b3b"
            strokeWidth="1.75"
            pointerEvents="none"
          />
        ) : null}
        {plot.handles.map((handle) => {
          const active = handle.index === selected;
          const readout = `${formatReadoutHz(Number(bands[handle.index].freq))}  ${formatReadoutDb(dbFromY(handle.y, plot.dbMin, plot.dbMax))}`;
          const showReadout = dragIndex === handle.index || hoverIndex === handle.index;
          return (
            <g key={`${plot.key}-${handle.index}`} data-handle>
              <circle
                cx={handle.x}
                cy={handle.y}
                r={active ? 16 : 13}
                fill="transparent"
                className={readOnly ? "" : "cursor-grab"}
                onPointerOver={() => setHoverIndex(handle.index)}
                onPointerOut={() => setHoverIndex((current) => (current === handle.index ? null : current))}
                onPointerDown={(event) => {
                  if (drawMode || disabled || readOnly) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const point = pointFrom(event.clientX, event.clientY);
                  const pointerY = clamp(point?.y ?? handle.y, PAD_T, PLOT_H - PAD_B);
                  dragOrigin.current = {
                    pointerDb: dbFromY(pointerY, plot.dbMin, plot.dbMax),
                    dotDb: handle.filterDb,
                    dbMin: plot.dbMin,
                    dbMax: plot.dbMax,
                  };
                  dragRef.current = handle.index;
                  setDragIndex(handle.index);
                  setSelected(handle.index);
                }}
              />
              <circle
                cx={handle.x}
                cy={handle.y}
                r={active ? 7 : 5.5}
                fill={active ? stroke : "#14120e"}
                stroke={stroke}
                strokeWidth="2"
                pointerEvents="none"
              />
              <text
                x={handle.x}
                y={handle.y - 22}
                textAnchor="middle"
                fill={stroke}
                fontSize="10"
                fontFamily="IBM Plex Mono, monospace"
                pointerEvents="none"
              >
                {TYPE_MARK[bands[handle.index].type]}
              </text>
              <text
                x={handle.x}
                y={handle.y - 10}
                textAnchor="middle"
                fill="#f3efe6"
                fontSize="11"
                fontFamily="IBM Plex Mono, monospace"
                pointerEvents="none"
              >
                {numberOf.get(handle.index)}
              </text>
              {showReadout ? (
                <text
                  x={handle.x}
                  y={Math.min(handle.y + 22, PLOT_H - 6)}
                  textAnchor="middle"
                  fill="#f3efe6"
                  fontSize="11"
                  fontFamily="IBM Plex Mono, monospace"
                  pointerEvents="none"
                >
                  {readout}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="text-sm text-muted">
        {note ??
          "Drag a point to set frequency and gain. Hover a dot to see its Hz and dB. Draw curve to sketch a shape; the freehand line stays until the next sketch."}
        {assumedRate ? " Axis runs to 24 kHz until a WAV sets Nyquist." : ""}
        {guide
          ? ` ${guide.label}: strongest ${formatSpan(guide.peakLow, guide.peakHigh)}, red line at ${formatHz(predominant)}, still present ${formatSpan(guide.low, guide.high)}.`
          : ""}
      </p>
      {readOnly ? null : (
        <ul className="flex flex-col gap-2">
          {bands.length === 0 ? <li className="text-sm text-muted">No bands. This channel is bypassed.</li> : null}
          {bandOrder.map(({ index, number }) => {
            const band = bands[index];
            const usesGain = gainMatters(band.type);
            const handle = plot.handles.find((item) => item.index === index);
            const dotLevel = handle
              ? formatReadoutDb(dbFromY(handle.y, plot.dbMin, plot.dbMax))
              : usesGain
                ? `${band.gain || "—"} dB`
                : "gain ignored";
            return (
              <li
                key={`${title}-${index}`}
                onClick={() => setSelected(index)}
                className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-2 ${
                  index === selected ? "border-accent bg-bg" : "border-line"
                }`}
              >
                <span className="px-1 font-mono text-sm" style={{ color: stroke }}>
                  {number}
                </span>
                <select
                  aria-label={`${title} band ${number} type`}
                  value={band.type}
                  disabled={disabled}
                  onChange={(event) => onChange(index, { type: event.target.value as FilterId })}
                  className="min-h-11 min-w-0 rounded-md border border-line bg-bg px-2 text-sm text-fg"
                >
                  {FILTERS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  disabled={disabled}
                  aria-label={`Remove ${title} band ${number}`}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-line"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
                <label className="col-span-3 flex min-w-0 items-center gap-2 text-sm">
                  <span className="text-muted">Q</span>
                  <input
                    aria-label={`${title} band ${number} Q`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={band.q}
                    disabled={disabled}
                    onChange={(event) => onChange(index, { q: event.target.value })}
                    className="min-h-11 w-24 rounded-md border border-line bg-bg px-2 font-mono text-sm text-fg"
                  />
                  <span className="truncate font-mono text-muted">
                    {band.freq || "—"} Hz · {dotLevel}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const PLOT_W = 800;
const PLOT_H = 300;
const PAD_L = 48;
const PAD_R = 18;
const PAD_T = 36;
const PAD_B = 32;

function buildPlot(
  bands: BandDraft[],
  sampleRate: number,
  fMin: number,
  fMax: number,
  library: EqLibrary | null,
  drawRoom: boolean,
  sketch: DrawPoint[] | null,
  preampDb: number,
) {
  const ordered = orderBands(bands).map((item) => bands[item.index]);
  const freqs = sampleFrequencies(ordered, fMin, fMax);
  const levels = responseCurve(ordered, freqs, sampleRate, library);
  const samples = freqs.map((hz, index) => {
    const db = levels[index];
    return { hz, db: Number.isFinite(db) ? db : -48 };
  });
  let filterPeak = -240;
  for (const sample of samples) {
    if (sample.db > filterPeak) filterPeak = sample.db;
    sample.db += preampDb;
  }
  let dbMin = -18;
  let dbMax = 18;
  for (const sample of samples) {
    if (sample.db < dbMin) dbMin = Math.max(sample.db, -36);
    if (sample.db > dbMax) dbMax = Math.min(sample.db, 36);
  }
  for (const band of ordered) {
    if (!gainMatters(band.type)) continue;
    const gain = Number(band.gain);
    if (!Number.isFinite(gain)) continue;
    dbMin = Math.min(dbMin, Math.max(gain, -36));
    dbMax = Math.max(dbMax, Math.min(gain, 36));
  }
  if (sketch) {
    for (const point of sketch) {
      dbMin = Math.min(dbMin, Math.max(point.db, -36));
      dbMax = Math.max(dbMax, Math.min(point.db, 36));
    }
  }
  if (drawRoom) {
    dbMin = Math.min(dbMin, -24);
    dbMax = Math.max(dbMax, 24);
  }
  dbMin = Math.floor(dbMin / 6) * 6;
  dbMax = Math.ceil(dbMax / 6) * 6;
  if (dbMax <= dbMin) {
    dbMin = -18;
    dbMax = 18;
  }

  const d = samples
    .map((sample, index) => {
      const x = xFromFreq(sample.hz, fMin, fMax);
      const y = yFromDb(clamp(sample.db, dbMin, dbMax), dbMin, dbMax);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const grid: { key: string; x1: number; y1: number; x2: number; y2: number; label?: string; labelX?: number; labelY?: number }[] = [];
  for (let db = dbMin; db <= dbMax; db += 6) {
    const y = yFromDb(db, dbMin, dbMax);
    grid.push({ key: `db-${db}`, x1: PAD_L, y1: y, x2: PLOT_W - PAD_R, y2: y, label: `${db}`, labelX: 4, labelY: y + 4 });
  }
  for (const hz of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (hz < fMin || hz > fMax) continue;
    const x = xFromFreq(hz, fMin, fMax);
    grid.push({
      key: `hz-${hz}`,
      x1: x,
      y1: PAD_T,
      x2: x,
      y2: PLOT_H - PAD_B,
      label: hz >= 1000 ? `${hz / 1000}k` : String(hz),
      labelX: x - 8,
      labelY: PLOT_H - 10,
    });
  }

  const handleFreqs = bands.map((band) => {
    const freq = Number(band.freq);
    return Number.isFinite(freq) && freq > 0 ? freq : 0;
  });
  const handleLevels = responseCurve(ordered, handleFreqs, sampleRate, library);
  const handles = bands.flatMap((band, index) => {
    const freq = handleFreqs[index] ?? 0;
    if (!(freq > 0)) return [];
    const summed = handleLevels[index];
    const filterDb = Number.isFinite(summed) ? summed : 0;
    const db = filterDb + preampDb;
    return [{ index, db, filterDb, x: xFromFreq(clamp(freq, fMin, fMax), fMin, fMax), y: yFromDb(clamp(db, dbMin, dbMax), dbMin, dbMax) }];
  });

  const key = ordered.map((band) => `${band.type}:${band.freq}:${band.gain}:${band.q}`).join("|");
  return { d, grid, handles, dbMin, dbMax, key, filterPeak };
}

const TYPE_MARK: Record<FilterId, string> = {
  peak: "PK",
  lowshelf: "LS",
  highshelf: "HS",
  lowpass: "LP",
  highpass: "HP",
  notch: "NO",
  bandpass: "BP",
  allpass: "AP",
};

function sketchPath(points: DrawPoint[], fMin: number, fMax: number, dbMin: number, dbMax: number): string {
  return points
    .map((point, index) => {
      const x = xFromFreq(clamp(point.hz, fMin, fMax), fMin, fMax);
      const y = yFromDb(clamp(point.db, dbMin, dbMax), dbMin, dbMax);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function formatReadoutHz(hz: number): string {
  if (!Number.isFinite(hz)) return "";
  if (hz >= 1000) {
    const kilo = hz / 1000;
    return `${kilo >= 10 ? kilo.toFixed(1) : kilo.toFixed(2)} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

function formatReadoutDb(db: number): string {
  if (!Number.isFinite(db)) return "";
  const rounded = Math.round(db * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded} dB`;
}

function orderBands(bands: BandDraft[]): { index: number; number: number }[] {
  return bands
    .map((band, index) => {
      const freq = Number(band.freq);
      return { index, freq: Number.isFinite(freq) && freq > 0 ? freq : Number.POSITIVE_INFINITY };
    })
    .sort((a, b) => a.freq - b.freq || a.index - b.index)
    .map((item, position) => ({ index: item.index, number: position + 1 }));
}

function sampleFrequencies(bands: BandDraft[], fMin: number, fMax: number): number[] {
  const freqs: number[] = [];
  const count = 220;
  const logMin = Math.log10(fMin);
  const logSpan = Math.log10(fMax) - logMin;
  for (let i = 0; i < count; i += 1) {
    freqs.push(10 ** (logMin + (logSpan * i) / (count - 1)));
  }
  for (const band of bands) {
    const fc = Number(band.freq);
    const q = Number(band.q);
    if (!(fc > 0) || !(q > 0)) continue;
    const steps = 16;
    const octaves = 2 / Math.max(q, 0.25);
    for (let k = -steps; k <= steps; k += 1) {
      const hz = fc * 2 ** ((k / steps) * octaves);
      if (hz >= fMin && hz <= fMax) freqs.push(hz);
    }
  }
  freqs.sort((a, b) => a - b);
  return freqs.filter((hz, index) => index === 0 || hz > freqs[index - 1] * 1.0008);
}

function xFromFreq(hz: number, fMin: number, fMax: number): number {
  const t = (Math.log10(hz) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin));
  return PAD_L + clamp(t, 0, 1) * (PLOT_W - PAD_L - PAD_R);
}

function freqFromX(x: number, fMin: number, fMax: number): number {
  const t = clamp((x - PAD_L) / (PLOT_W - PAD_L - PAD_R), 0, 1);
  return 10 ** (Math.log10(fMin) + t * (Math.log10(fMax) - Math.log10(fMin)));
}

function yFromDb(db: number, dbMin: number, dbMax: number): number {
  const t = (dbMax - db) / (dbMax - dbMin);
  return PAD_T + t * (PLOT_H - PAD_T - PAD_B);
}

function dbFromY(y: number, dbMin: number, dbMax: number): number {
  const t = clamp((y - PAD_T) / (PLOT_H - PAD_T - PAD_B), 0, 1);
  return dbMax - t * (dbMax - dbMin);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatFreq(hz: number): string {
  if (hz >= 100) return String(Math.round(hz));
  return String(Math.round(hz * 10) / 10);
}

function formatDb(db: number): string {
  return String(Math.round(db * 10) / 10);
}

type FrequencyGuide = {
  id: string;
  group: string;
  label: string;
  low: number;
  peakLow: number;
  peakHigh: number;
  high: number;
};

const GUIDE_GROUPS = ["Voice", "Pop and jazz", "Drums", "Bass", "Guitar and keys", "Strings", "Winds and brass"];

const GUIDES: FrequencyGuide[] = [
  { id: "speech-male", group: "Voice", label: "Male speech", low: 80, peakLow: 100, peakHigh: 300, high: 8000 },
  { id: "speech-female", group: "Voice", label: "Female speech", low: 150, peakLow: 200, peakHigh: 500, high: 10000 },
  { id: "bass-voice", group: "Voice", label: "Bass voice", low: 60, peakLow: 80, peakHigh: 200, high: 1500 },
  { id: "baritone", group: "Voice", label: "Baritone", low: 90, peakLow: 110, peakHigh: 320, high: 2500 },
  { id: "tenor", group: "Voice", label: "Tenor", low: 120, peakLow: 160, peakHigh: 480, high: 4000 },
  { id: "alto", group: "Voice", label: "Alto", low: 140, peakLow: 200, peakHigh: 600, high: 4500 },
  { id: "soprano", group: "Voice", label: "Soprano", low: 220, peakLow: 300, peakHigh: 1100, high: 8000 },
  { id: "child", group: "Voice", label: "Child voice", low: 250, peakLow: 350, peakHigh: 1200, high: 10000 },
  { id: "pop-male", group: "Pop and jazz", label: "Pop male", low: 85, peakLow: 150, peakHigh: 450, high: 12000 },
  { id: "pop-female", group: "Pop and jazz", label: "Pop female", low: 180, peakLow: 250, peakHigh: 800, high: 14000 },
  { id: "pop-belt", group: "Pop and jazz", label: "Pop belt", low: 220, peakLow: 400, peakHigh: 1600, high: 12000 },
  { id: "jazz-male", group: "Pop and jazz", label: "Jazz male", low: 80, peakLow: 110, peakHigh: 320, high: 6000 },
  { id: "jazz-female", group: "Pop and jazz", label: "Jazz female", low: 150, peakLow: 200, peakHigh: 650, high: 8000 },
  { id: "crooner", group: "Pop and jazz", label: "Crooner", low: 75, peakLow: 100, peakHigh: 250, high: 3500 },
  { id: "kick", group: "Drums", label: "Kick drum", low: 30, peakLow: 50, peakHigh: 100, high: 5000 },
  { id: "snare", group: "Drums", label: "Snare", low: 100, peakLow: 180, peakHigh: 350, high: 10000 },
  { id: "tom", group: "Drums", label: "Tom", low: 60, peakLow: 100, peakHigh: 250, high: 4000 },
  { id: "hihat", group: "Drums", label: "Hi-hat", low: 300, peakLow: 6000, peakHigh: 12000, high: 18000 },
  { id: "cymbal", group: "Drums", label: "Cymbal", low: 200, peakLow: 4000, peakHigh: 10000, high: 18000 },
  { id: "bass-guitar", group: "Bass", label: "Bass guitar", low: 40, peakLow: 60, peakHigh: 250, high: 4000 },
  { id: "double-bass", group: "Bass", label: "Double bass", low: 40, peakLow: 50, peakHigh: 200, high: 2500 },
  { id: "synth-bass", group: "Bass", label: "Synth bass", low: 30, peakLow: 40, peakHigh: 150, high: 2000 },
  { id: "electric-guitar", group: "Guitar and keys", label: "Electric guitar", low: 80, peakLow: 200, peakHigh: 900, high: 6000 },
  { id: "acoustic-guitar", group: "Guitar and keys", label: "Acoustic guitar", low: 80, peakLow: 150, peakHigh: 700, high: 5000 },
  { id: "piano", group: "Guitar and keys", label: "Piano", low: 28, peakLow: 200, peakHigh: 1200, high: 8000 },
  { id: "organ", group: "Guitar and keys", label: "Organ", low: 30, peakLow: 80, peakHigh: 500, high: 6000 },
  { id: "violin", group: "Strings", label: "Violin", low: 200, peakLow: 400, peakHigh: 2500, high: 12000 },
  { id: "viola", group: "Strings", label: "Viola", low: 130, peakLow: 200, peakHigh: 1000, high: 6000 },
  { id: "cello", group: "Strings", label: "Cello", low: 65, peakLow: 100, peakHigh: 500, high: 4000 },
  { id: "flute", group: "Winds and brass", label: "Flute", low: 260, peakLow: 500, peakHigh: 2500, high: 8000 },
  { id: "clarinet", group: "Winds and brass", label: "Clarinet", low: 140, peakLow: 250, peakHigh: 1200, high: 5000 },
  { id: "saxophone", group: "Winds and brass", label: "Saxophone", low: 100, peakLow: 200, peakHigh: 900, high: 6000 },
  { id: "trumpet", group: "Winds and brass", label: "Trumpet", low: 160, peakLow: 300, peakHigh: 1500, high: 7000 },
  { id: "trombone", group: "Winds and brass", label: "Trombone", low: 70, peakLow: 120, peakHigh: 600, high: 4000 },
  { id: "horn", group: "Winds and brass", label: "French horn", low: 60, peakLow: 100, peakHigh: 500, high: 3000 },
];

function guideOpacity(hz: number, guide: FrequencyGuide): number {
  if (hz <= guide.low || hz >= guide.high) return 0;
  if (hz >= guide.peakLow && hz <= guide.peakHigh) return 0.55;
  if (hz < guide.peakLow) {
    const span = Math.log(guide.peakLow) - Math.log(guide.low);
    return span > 0 ? (0.55 * (Math.log(hz) - Math.log(guide.low))) / span : 0;
  }
  const span = Math.log(guide.high) - Math.log(guide.peakHigh);
  return span > 0 ? (0.55 * (Math.log(guide.high) - Math.log(hz))) / span : 0;
}

function guideStops(guide: FrequencyGuide, fMin: number, fMax: number): { offset: string; opacity: number }[] {
  const marks = [fMin, fMax, guide.low, guide.peakLow, guide.peakHigh, guide.high].filter(
    (hz) => hz >= fMin && hz <= fMax,
  );
  marks.sort((a, b) => a - b);
  const width = PLOT_W - PAD_L - PAD_R;
  const stops: { offset: string; opacity: number }[] = [];
  for (const hz of marks) {
    const offset = `${(((xFromFreq(hz, fMin, fMax) - PAD_L) / width) * 100).toFixed(2)}%`;
    const opacity = guideOpacity(hz, guide);
    const previous = stops[stops.length - 1];
    if (previous?.offset === offset) previous.opacity = Math.max(previous.opacity, opacity);
    else stops.push({ offset, opacity });
  }
  return stops;
}

function formatSpan(low: number, high: number): string {
  return `${formatHz(low)}–${formatHz(high)}`;
}

function formatHz(hz: number): string {
  if (hz >= 1000) {
    const kilo = hz / 1000;
    return `${Number.isInteger(kilo) ? kilo : kilo.toFixed(1)} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

function Choice({
  legend,
  value,
  onChange,
  disabled,
  options,
}: {
  legend: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  options: { id: string; label: string; detail: string }[];
}) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2">
        {options.map((option) => {
          const selected = value === option.id;
          return (
            <label
              key={option.id}
              className={`flex min-h-11 cursor-pointer gap-3 rounded-md border px-3 py-2 ${
                selected ? "border-accent bg-bg" : "border-line bg-bg"
              } ${disabled ? "cursor-default opacity-50" : ""}`}
            >
              <input
                type="radio"
                name={legend}
                value={option.id}
                checked={selected}
                onChange={() => onChange(option.id)}
                className="mt-1 accent-accent"
              />
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-sm text-muted">{option.detail}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
