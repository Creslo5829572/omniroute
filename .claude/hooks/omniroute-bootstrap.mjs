// Waits for the local OmniRoute gateway, ensures a gateway API key for Claude Code
// (saved to $DATA_DIR/claude-code.key) and imports provider API keys found in env.
//
// Provider keys: any OMNIROUTE_PROVIDER_KEY_<PROVIDER_ID> (dashes as underscores, e.g.
// OMNIROUTE_PROVIDER_KEY_OPENROUTER), plus the common names listed in WELL_KNOWN.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = process.env.PORT || "20128";
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || join(homedir(), ".omniroute");
const KEY_FILE = join(DATA_DIR, "claude-code.key");
const PASSWORD = process.env.INITIAL_PASSWORD || readEnvFile("INITIAL_PASSWORD") || "CHANGEME";

const WELL_KNOWN = {
  GEMINI_API_KEY: "gemini",
  GOOGLE_API_KEY: "gemini",
  GROQ_API_KEY: "groq",
  OPENROUTER_API_KEY: "openrouter",
  MISTRAL_API_KEY: "mistral",
  CEREBRAS_API_KEY: "cerebras",
  NVIDIA_API_KEY: "nvidia",
  DEEPSEEK_API_KEY: "deepseek",
  OPENAI_API_KEY: "openai",
  TOGETHER_API_KEY: "together",
  FIREWORKS_API_KEY: "fireworks",
  COHERE_API_KEY: "cohere",
  HF_TOKEN: "huggingface",
  XAI_API_KEY: "xai",
  SAMBANOVA_API_KEY: "sambanova",
};

function readEnvFile(name) {
  try {
    const line = readFileSync(".env", "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = "";

async function call(path, { method = "GET", body, bearer } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function waitHealthy() {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await call("/api/health")).status === 200) return;
    } catch {
      // still booting
    }
    await sleep(3000);
  }
  throw new Error("gateway did not become healthy within 15 minutes");
}

async function ensureGatewayKey() {
  if (existsSync(KEY_FILE)) {
    const key = readFileSync(KEY_FILE, "utf8").trim();
    if ((await call("/v1/models", { bearer: key })).status === 200) return key;
  }
  const { json } = await call("/api/keys", { method: "POST", body: { name: "claude-code" } });
  if (!json.key) throw new Error(`could not create gateway key: ${JSON.stringify(json)}`);
  writeFileSync(KEY_FILE, `${json.key}\n`, { mode: 0o600 });
  return json.key;
}

function collectProviderKeys() {
  const found = new Map();
  for (const [name, provider] of Object.entries(WELL_KNOWN)) {
    if (process.env[name]) found.set(provider, process.env[name]);
  }
  for (const [name, value] of Object.entries(process.env)) {
    const m = name.match(/^OMNIROUTE_PROVIDER_KEY_(.+)$/);
    if (m && value) found.set(m[1].toLowerCase().replace(/_/g, "-"), value);
  }
  return found;
}

async function importProviderKeys() {
  const wanted = collectProviderKeys();
  if (wanted.size === 0) return;
  const { json } = await call("/api/providers");
  const existing = new Set((json.connections || []).map((c) => c.name));
  for (const [provider, apiKey] of wanted) {
    const name = `env:${provider}`;
    if (existing.has(name)) continue;
    const res = await call("/api/providers", { method: "POST", body: { provider, apiKey, name } });
    console.log(`provider ${provider}: HTTP ${res.status}`);
  }
}

try {
  await waitHealthy();
  const login = await call("/api/auth/login", { method: "POST", body: { password: PASSWORD } });
  if (login.status !== 200) throw new Error(`dashboard login failed: HTTP ${login.status}`);
  await ensureGatewayKey();
  await importProviderKeys();
  console.log(`ready: key saved to ${KEY_FILE}`);
} catch (err) {
  console.error(`bootstrap failed: ${err.message}`);
  process.exit(1);
}
