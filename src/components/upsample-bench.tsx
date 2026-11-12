import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Play, SquareTerminal, Download } from "lucide-react";

import {
  DITHERS,
  FILTERS,
  PHASES,
  QUALITIES,
  RATES,
  THREAD_CHOICES,
  assess,
  readWavFacts,
  sanitizeOutputName,
  suggestOutputName,
  DEFAULT_SETTINGS,
  type BenchSettings,
  type DitherId,
  type FilterId,
  type PhaseId,
  type QualityId,
  type RateHz,
  type ThreadChoice,
  type WavFacts,
} from "@/lib/cli-spec";

type Folder = {
  name: string;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
  }>;
};

type RunEvent =
  | { type: "log"; text: string }
  | { type: "error"; text: string }
  | { type: "done"; mode: "info" }
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

export function UpsampleBench() {
  const [settings, setSettings] = useState<BenchSettings>(DEFAULT_SETTINGS);
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
  const [zipHref, setZipHref] = useState("/upsample-bench.zip");
  const [zipNote, setZipNote] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/run")
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
    setZipHref(`${prefix}/upsample-bench.zip`);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, running]);

  const verdict = useMemo(
    () => assess(settings, wav, file != null, file?.name ?? "input.wav"),
    [settings, wav, file],
  );

  const filterLocked = wav != null && wav.sampleRate === settings.rate;
  const outputLocked = settings.mode === "info";
  const blocked = verdict.errors.length > 0 || running || cliReady === false;

  function patch(partial: Partial<BenchSettings>) {
    setSettings((current) => ({ ...current, ...partial }));
  }

  function onRate(rate: RateHz) {
    setSettings((current) => ({
      ...current,
      rate,
      outputName: nameTouched || !file ? current.outputName : suggestOutputName(file.name, rate),
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
    if (!nameTouched) {
      setSettings((current) => ({ ...current, outputName: suggestOutputName(next.name, current.rate) }));
    }
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
    const name = sanitizeOutputName(settings.outputName);
    if (settings.mode === "convert" && folder && name && !settings.overwrite) {
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
      const response = await fetch("/api/run", { method: "POST", body });
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
          if (event.type === "log") {
            setLog((current) => current + event.text);
          } else if (event.type === "error") {
            setLog((current) => `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${event.text}\n`);
          } else if (event.type === "done" && event.mode === "convert") {
            download = { id: event.id, filename: event.filename };
          }
        }
      }
      if (download) {
        const fileResponse = await fetch(`/api/result/${download.id}`);
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
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-accent">wav-upsample</p>
        <h1 className="text-3xl font-semibold tracking-tight">Upsample bench</h1>
        <p className="max-w-2xl text-base text-muted">
          Pick a WAV, set a destination, and run the resampler. Choices the CLI would refuse stay disabled.
        </p>
        <p className="text-sm text-muted">
          {cliReady == null ? "Checking the CLI…" : cliReady ? (cliVersion ?? "CLI ready") : "CLI unavailable"}
        </p>
        <a
          href={zipHref}
          download="upsample-bench.zip"
          onClick={() =>
            setZipNote("Download started. If no file appears, the preview blocked it — use the file card in the chat.")
          }
          className="inline-flex min-h-11 w-fit items-center justify-center gap-2 rounded-lg bg-accent px-5 font-medium text-accent-ink"
        >
          <Download className="size-4" aria-hidden />
          Download upsample-bench.zip
        </a>
        {zipNote ? <p className="text-sm text-muted">{zipNote}</p> : null}
      </header>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
          <h2 className="text-lg font-medium">Files</h2>
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Input WAV</span>
            <input
              type="file"
              accept=".wav,audio/wav,audio/x-wav"
              className="min-h-11 text-sm file:mr-3 file:min-h-11 file:rounded-md file:border-0 file:bg-accent file:px-4 file:font-medium file:text-accent-ink"
              onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
              disabled={running}
            />
          </label>
          {fileError ? <p className="text-sm text-accent">{fileError}</p> : null}
          {wav ? (
            <p className="font-mono text-sm text-muted">
              {wav.sampleRate} Hz · {wav.channels} ch · {wav.bits}-bit {wav.kind}
              {duration ? ` · ${duration}` : ""}
            </p>
          ) : null}

          <fieldset className="flex flex-col gap-3" disabled={outputLocked || running}>
            <legend className="text-sm font-medium">Output</legend>
            <label className="flex flex-col gap-2 text-sm">
              <span className="text-muted">File name</span>
              <input
                value={settings.outputName}
                onChange={(event) => {
                  setNameTouched(true);
                  patch({ outputName: event.target.value });
                }}
                spellCheck={false}
                placeholder="album-96k.wav"
                className="min-h-11 rounded-md border border-line bg-bg px-3 font-mono text-sm text-fg disabled:opacity-50"
              />
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => void onBrowseFolder()}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-bg px-4 text-sm font-medium"
              >
                <FolderOpen className="size-4" aria-hidden />
                Browse folder
              </button>
              <p className="self-center text-sm text-muted">
                {folder ? folder.name : "No folder yet — the file downloads instead"}
              </p>
            </div>
            {folderNote ? <p className="text-sm text-muted">{folderNote}</p> : null}
            <label className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-line bg-bg px-3">
              <span>
                <span className="block text-sm font-medium">Overwrite destination</span>
                <span className="block text-sm text-muted">Off refuses a file that is already there.</span>
              </span>
              <input
                type="checkbox"
                checked={settings.overwrite}
                onChange={(event) => patch({ overwrite: event.target.checked })}
                className="size-5 accent-accent"
              />
            </label>
          </fieldset>
        </div>

        <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
          <h2 className="text-lg font-medium">Job</h2>
          <Choice
            legend="Action"
            value={settings.mode}
            onChange={(mode) => patch({ mode: mode as BenchSettings["mode"] })}
            disabled={running}
            options={[
              { id: "convert", label: "Convert", detail: "Write a WAV. Output name is required." },
              { id: "info", label: "Inspect", detail: "Print the filter and exit. No audio is written." },
            ]}
          />
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Output rate</span>
            <select
              value={settings.rate}
              onChange={(event) => onRate(Number(event.target.value) as RateHz)}
              disabled={running}
              className="min-h-11 rounded-md border border-line bg-bg px-3 text-sm text-fg"
            >
              {RATES.map((rate) => (
                <option key={rate.hz} value={rate.hz}>
                  {rate.label}
                </option>
              ))}
            </select>
          </label>
          <Choice
            legend="Bit depth"
            value={String(settings.bits)}
            onChange={(bits) => patch({ bits: bits === "16" ? 16 : 24 })}
            disabled={running}
            options={[
              { id: "16", label: "16-bit", detail: "Needs dither. Shaped helps at 44.1 kHz." },
              { id: "24", label: "24-bit", detail: "Archival PCM. TPDF is enough." },
            ]}
          />
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4" aria-disabled={filterLocked}>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-medium">Filter</h2>
          {verdict.taps != null ? (
            <p className="font-mono text-sm text-muted">{verdict.taps} taps / output sample</p>
          ) : null}
        </div>
        {filterLocked ? (
          <p className="text-sm text-muted">Locked because the output rate matches the file. No lowpass is designed.</p>
        ) : null}
        <Choice
          legend="Window"
          value={settings.filter}
          onChange={(filter) => patch({ filter: filter as FilterId })}
          disabled={running || filterLocked}
          options={FILTERS.map((item) => ({ id: item.id, label: item.label, detail: item.detail }))}
        />
        <Choice
          legend="Phase"
          value={settings.phase}
          onChange={(phase) => patch({ phase: phase as PhaseId })}
          disabled={running || filterLocked}
          options={PHASES.map((item) => ({ id: item.id, label: item.label, detail: item.detail }))}
        />
        <Choice
          legend="Quality"
          value={settings.quality}
          onChange={(quality) => patch({ quality: quality as QualityId })}
          disabled={running || filterLocked}
          options={QUALITIES.map((item) => ({ id: item.id, label: item.label, detail: item.detail }))}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Override
            label="Custom bandwidth"
            detail="Fraction of the lower Nyquist, 0.50–0.995. Overrides the quality preset."
            enabled={!settings.usePresetBandwidth}
            onToggle={(on) => patch({ usePresetBandwidth: !on })}
            disabled={running || filterLocked}
            value={settings.bandwidth}
            min={0.5}
            max={0.995}
            step={0.005}
            onValue={(bandwidth) => patch({ bandwidth })}
          />
          <Override
            label="Custom attenuation"
            detail="Kaiser design stopband, 40–200 dB. Sets length for every window."
            enabled={!settings.usePresetAtten}
            onToggle={(on) => patch({ usePresetAtten: !on })}
            disabled={running || filterLocked}
            value={settings.atten}
            min={40}
            max={200}
            step={1}
            onValue={(atten) => patch({ atten })}
          />
        </div>
      </section>

      <section className="grid gap-4 rounded-lg border border-line bg-surface p-4 lg:grid-cols-2">
        <Choice
          legend="Dither"
          value={settings.dither}
          onChange={(dither) => patch({ dither: dither as DitherId })}
          disabled={running}
          options={DITHERS.map((item) => ({ id: item.id, label: item.label, detail: item.detail }))}
        />
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Headroom {settings.headroom.toFixed(1)} dB</span>
            <input
              type="range"
              min={0}
              max={12}
              step={0.5}
              value={settings.headroom}
              onChange={(event) => patch({ headroom: Number(event.target.value) })}
              disabled={running}
              className="accent-accent"
            />
            <span className="text-muted">Gain cut before the quantiser. Use 1–3 dB if the log says clipped.</span>
          </label>
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Threads</span>
            <select
              value={settings.threads}
              onChange={(event) => patch({ threads: Number(event.target.value) as ThreadChoice })}
              disabled={running}
              className="min-h-11 rounded-md border border-line bg-bg px-3 text-sm text-fg"
            >
              {THREAD_CHOICES.map((count) => (
                <option key={count} value={count}>
                  {count === 0 ? "All cores" : String(count)}
                </option>
              ))}
            </select>
          </label>
        </div>
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
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
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

function Override({
  label,
  detail,
  enabled,
  onToggle,
  disabled,
  value,
  min,
  max,
  step,
  onValue,
}: {
  label: string;
  detail: string;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  disabled: boolean;
  value: number;
  min: number;
  max: number;
  step: number;
  onValue: (value: number) => void;
}) {
  return (
    <div className={`flex flex-col gap-2 rounded-md border border-line bg-bg p-3 ${disabled ? "opacity-50" : ""}`}>
      <label className="flex min-h-11 items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onToggle(event.target.checked)}
          disabled={disabled}
          className="size-5 accent-accent"
        />
      </label>
      <p className="text-sm text-muted">{detail}</p>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={!enabled || disabled}
        onChange={(event) => onValue(Number(event.target.value))}
        className="min-h-11 rounded-md border border-line bg-surface px-3 font-mono text-sm text-fg disabled:opacity-50"
      />
    </div>
  );
}
