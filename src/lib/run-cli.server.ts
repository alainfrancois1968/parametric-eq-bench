import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assess,
  buildArgv,
  formatCommand,
  parseSettings,
  readWavFacts,
  sanitizeOutputName,
  type BenchSettings,
  type WavFacts,
} from "@/lib/cli-spec";

const ROOT = "/tmp/wav-bench";

function binPath(): string {
  return process.env.WAV_UPSAMPLE_BIN?.trim() || path.join(process.cwd(), "bin", "wav-upsample");
}

export async function cliStatus(): Promise<{ ready: boolean; version: string | null }> {
  const bin = binPath();
  try {
    await access(bin);
  } catch {
    return { ready: false, version: null };
  }
  const version = await new Promise<string | null>((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
  return { ready: version != null, version };
}

type Send = (event: Record<string, unknown>) => void;

export async function executeRun(form: FormData, send: Send): Promise<void> {
  const status = await cliStatus();
  if (!status.ready) {
    send({
      type: "error",
      text: "wav-upsample is not available in this environment.",
    });
    return;
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    send({ type: "error", text: "No input file was uploaded." });
    return;
  }
  if (file.size <= 0) {
    send({ type: "error", text: "Input WAV is empty." });
    return;
  }

  let settings: BenchSettings | null = null;
  try {
    settings = parseSettings(JSON.parse(String(form.get("settings") ?? "")));
  } catch {
    settings = null;
  }
  if (!settings) {
    send({ type: "error", text: "Settings were rejected. Reload the page and try again." });
    return;
  }

  const facts = await readWavFacts(file);
  if ("error" in facts) {
    send({ type: "error", text: facts.error });
    return;
  }

  const verdict = assess(settings, facts, true);
  if (verdict.errors.length > 0) {
    send({ type: "error", text: verdict.errors[0] ?? "Invalid settings." });
    return;
  }

  const id = randomBytes(16).toString("hex");
  const jobDir = path.join(ROOT, id);
  const inputPath = path.join(jobDir, "input.wav");
  await mkdir(jobDir, { recursive: true });
  await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));

  let outputPath: string | null = null;
  let outputName: string | null = null;
  if (settings.mode === "convert") {
    outputName = sanitizeOutputName(settings.outputName);
    if (!outputName) {
      send({ type: "error", text: "Output file name was rejected." });
      await rm(jobDir, { recursive: true, force: true });
      return;
    }
    const outDir = path.join(ROOT, "outputs");
    await mkdir(outDir, { recursive: true });
    outputPath = path.join(outDir, `${id}.wav`);
    const marker = path.join(ROOT, "names", outputName);
    await mkdir(path.dirname(marker), { recursive: true });
    let previousId: string | null = null;
    try {
      previousId = (await readFile(marker, "utf8")).trim();
    } catch {
      previousId = null;
    }
    if (previousId && !settings.overwrite) {
      send({
        type: "log",
        text: `$ ${formatCommand(settings, facts, file.name)}\n`,
      });
      send({
        type: "error",
        text: `refusing to overwrite ${outputName}\noverwrite is off — turn it on to replace the existing destination`,
      });
      await rm(jobDir, { recursive: true, force: true });
      return;
    }
    if (previousId && settings.overwrite && /^[a-f0-9]{32}$/.test(previousId)) {
      await rm(path.join(outDir, `${previousId}.wav`), { force: true });
      await rm(path.join(ROOT, "jobs", `${previousId}.json`), { force: true });
    }
  }

  const argv = buildArgv(settings, facts, inputPath, outputPath);
  if (!argv) {
    send({ type: "error", text: "Could not build a legal command." });
    await rm(jobDir, { recursive: true, force: true });
    return;
  }

  send({ type: "log", text: `$ ${formatCommand(settings, facts, file.name)}\n` });
  const code = await runProcess(binPath(), argv, send);
  if (code !== 0) {
    send({ type: "error", text: `wav-upsample exited ${code}` });
    await rm(jobDir, { recursive: true, force: true });
    if (outputPath) await rm(outputPath, { force: true });
    return;
  }

  if (settings.mode === "info" || !outputPath || !outputName) {
    await rm(jobDir, { recursive: true, force: true });
    send({ type: "done", mode: "info" });
    return;
  }

  const sidecar = {
    id,
    filename: outputName,
    path: outputPath,
    created: Date.now(),
  };
  await mkdir(path.join(ROOT, "jobs"), { recursive: true });
  await writeFile(path.join(ROOT, "jobs", `${id}.json`), JSON.stringify(sidecar));
  await mkdir(path.join(ROOT, "names"), { recursive: true });
  await writeFile(path.join(ROOT, "names", outputName), id);
  await rm(jobDir, { recursive: true, force: true });
  send({
    type: "done",
    mode: "convert",
    id,
    filename: outputName,
  });
}

function runProcess(bin: string, argv: string[], send: Send): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    const push = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text) send({ type: "log", text });
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (err) => {
      send({ type: "log", text: `${err.message}\n` });
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function openResult(id: string): Promise<{ filename: string; stream: ReadableStream } | null> {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const sidecarPath = path.join(ROOT, "jobs", `${id}.json`);
  let sidecar: { filename?: string; path?: string };
  try {
    sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as { filename?: string; path?: string };
  } catch {
    return null;
  }
  if (!sidecar.path || !sidecar.filename) return null;
  const resolved = path.resolve(sidecar.path);
  if (!resolved.startsWith(path.join(ROOT, "outputs") + path.sep)) return null;
  try {
    await access(resolved);
  } catch {
    return null;
  }
  const nodeStream = createReadStream(resolved);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
  return { filename: sidecar.filename, stream };
}

export type { WavFacts };
