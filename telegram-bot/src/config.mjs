import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CONFIG_PATH = process.env.DSH_TG_CONFIG ?? path.join(ROOT_DIR, "config.json");
const STATE_PATH = process.env.DSH_TG_STATE ?? path.join(ROOT_DIR, "state.json");

const DEFAULTS = {
  dshUrl: "http://127.0.0.1:3080",
  defaultCwd: process.env.HOME ?? "/Users/hedelka",
  whisperModel: "models/ggml-base.bin",
  streamIntervalMs: 1200,
  maxMessageChars: 3800,
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `config.json not found at ${CONFIG_PATH}. Copy config.example.json to config.json and fill in telegramToken.`
    );
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const cfg = { ...DEFAULTS, ...raw };
  if (!cfg.telegramToken) throw new Error("config.json: telegramToken is required");
  cfg.whisperModel = path.resolve(ROOT_DIR, cfg.whisperModel);
  return cfg;
}

export function statePath() {
  return STATE_PATH;
}
