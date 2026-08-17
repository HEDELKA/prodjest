import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

/**
 * Transcribe a voice note (Ogg/Opus from Telegram) with the local whisper.cpp
 * CLI. whisper-cli decodes ogg/vorbis and wav natively, but Telegram voice
 * notes are ogg/opus — so on decode failure we first convert with opusdec
 * (or afconvert on macOS) into a wav and retry.
 */
export async function transcribeVoice({ cli, model, oggPath, opusdec }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-tg-"));
  try {
    // Attempt 1: feed the .ogg straight into whisper-cli.
    let wavPath = oggPath;
    let triedDirect = true;
    try {
      const text = await runWhisper(cli, model, wavPath, dir);
      if (text.trim()) return text;
    } catch (err) {
      triedDirect = false;
      console.log("[whisper] direct ogg decode failed, converting:", err.message);
    }

    // Attempt 2: convert to wav, then whisper.
    const converter = opusdec
      ? (input, output) => execFileP(opusdec, ["--rate", "16000", input, output], { timeout: 60000 })
      : (input, output) =>
          execFileP("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", input, output], { timeout: 60000 });
    const wav = path.join(dir, "conv.wav");
    await converter(oggPath, wav);
    return await runWhisper(cli, model, wav, dir);
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runWhisper(cli, model, audioPath, dir) {
  const base = path.join(dir, "out");
  await execFileP(
    cli,
    ["-m", model, "-l", "auto", "-np", "-nt", "-oj", "-of", base, audioPath],
    { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }
  );
  const json = JSON.parse(await readFile(`${base}.json`, "utf8"));
  const text = (json.transcription ?? [])
    .map((s) => s.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}
