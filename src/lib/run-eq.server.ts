import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { accessSync, constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assessEq, parseEqSettings } from "@/lib/eq-spec";
import { nodeEqLibrary } from "@/lib/eq-core.server";
import { readWavFacts, sanitizeOutputName } from "@/lib/cli-spec";

const ROOT = "/tmp/eq-bench";

function binPath(): string {
  const fromEnv = process.env.PARAMETRIC_EQ_BIN?.trim();
  if (fromEnv) return fromEnv;
  const local = path.join(process.cwd(), "bin", "parametric-eq");
  if (executable(local)) return local;
  return findOnPath("parametric-eq") ?? findOnPath("parametric-eq.exe") ?? local;
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}

export async function eqStatus(): Promise<{ ready: boolean; version: string | null }> {
  const bin = binPath();
  try {
    await access(bin);
  } catch {
    return { ready: false, version: null };
  }
  const version = await new Promise<string | null>((resolve) => {
    let child;
    try {
      child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
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

export async function executeEq(form: FormData, send: Send): Promise<void> {
  const status = await eqStatus();
  if (!status.ready) {
    send({ type: "error", text: "parametric-eq is not available in this environment." });
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

  const settings = parseEqSettings(JSON.parse(safeJson(form.get("settings"))));
  if (!settings) {
    send({ type: "error", text: "Settings were rejected. Reload the page and try again." });
    return;
  }

  const facts = await readWavFacts(file);
  if ("error" in facts) {
    send({ type: "error", text: facts.error });
    return;
  }

  const verdict = assessEq(settings, facts, true, file.name, nodeEqLibrary());
  if (verdict.errors.length > 0 || !verdict.preset) {
    send({ type: "error", text: verdict.errors[0] ?? "Invalid settings." });
    return;
  }

  const outputName = sanitizeOutputName(settings.outputName);
  if (!outputName) {
    send({ type: "error", text: "Output file name was rejected." });
    return;
  }

  const id = randomBytes(16).toString("hex");
  const jobDir = path.join(ROOT, id);
  const inputPath = path.join(jobDir, "input.wav");
  const outDir = path.join(ROOT, "outputs");
  const outputPath = path.join(outDir, `${id}.wav`);
  await mkdir(jobDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));

  const marker = path.join(ROOT, "names", outputName);
  await mkdir(path.dirname(marker), { recursive: true });
  let previousId: string | null = null;
  try {
    previousId = (await readFile(marker, "utf8")).trim();
  } catch {
    previousId = null;
  }
  if (previousId && !settings.overwrite) {
    send({ type: "log", text: `$ ${verdict.command}\n` });
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

  const argv = [inputPath, outputPath, "--format", settings.format, "--eq", JSON.stringify(verdict.preset)];
  send({ type: "log", text: `$ ${verdict.command}\n` });
  const code = await runProcess(binPath(), argv, send);
  await rm(jobDir, { recursive: true, force: true });
  if (code !== 0) {
    send({ type: "error", text: `parametric-eq exited ${code}` });
    await rm(outputPath, { force: true });
    return;
  }

  await mkdir(path.join(ROOT, "jobs"), { recursive: true });
  await writeFile(
    path.join(ROOT, "jobs", `${id}.json`),
    JSON.stringify({ id, filename: outputName, path: outputPath, created: Date.now() }),
  );
  await writeFile(marker, id);
  send({ type: "done", mode: "convert", id, filename: outputName });
}

function safeJson(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function runProcess(bin: string, argv: string[], send: Send): Promise<number> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not start parametric-eq.";
      send({ type: "log", text: `${message}\n` });
      resolve(127);
      return;
    }
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

export async function openEqResult(id: string): Promise<{ filename: string; stream: ReadableStream } | null> {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  let sidecar: { filename?: string; path?: string };
  try {
    sidecar = JSON.parse(await readFile(path.join(ROOT, "jobs", `${id}.json`), "utf8")) as {
      filename?: string;
      path?: string;
    };
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
        controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
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
