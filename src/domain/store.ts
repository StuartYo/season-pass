// Household state storage. Three backends, picked from the environment:
//  1. Upstash Redis REST (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN): durable, works across serverless instances.
//  2. JSON files (local dev: .data/, on Vercel: /tmp/renewwise): good enough for a demo, not durable on serverless.
//  3. Memory only (RENEWWISE_STORE=memory, used by tests).
import { promises as fs } from "fs";
import path from "path";
import { HouseholdState } from "./types";
import { seedHousehold } from "./seed";

const memory = new Map<string, HouseholdState>();
const KEY_RE = /^[a-z0-9-]{3,48}$/;

export function safeHouseholdId(id: string | null | undefined): string {
  const v = (id ?? "").toLowerCase().trim();
  return KEY_RE.test(v) ? v : "demo";
}

function backend(): "upstash" | "file" | "memory" {
  if (process.env.RENEWWISE_STORE === "memory") return "memory";
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) return "upstash";
  return "file";
}

function dir() {
  return process.env.RENEWWISE_DATA_DIR ?? (process.env.VERCEL ? "/tmp/renewwise" : path.join(process.cwd(), ".data"));
}

async function upstash(cmd: unknown[]) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`store error ${r.status}`);
  return (await r.json()).result;
}

export async function load(householdId: string): Promise<HouseholdState> {
  const id = safeHouseholdId(householdId);
  const b = backend();
  if (b === "memory") return structuredClone(memory.get(id) ?? seedHousehold(id));
  try {
    if (b === "upstash") {
      const raw = await upstash(["GET", `renewwise:${id}`]);
      if (raw) return JSON.parse(raw);
    } else {
      const raw = await fs.readFile(path.join(dir(), `${id}.json`), "utf8");
      return JSON.parse(raw);
    }
  } catch {
    /* first visit or store unavailable: fall through */
  }
  return structuredClone(memory.get(id) ?? seedHousehold(id));
}

export async function save(state: HouseholdState): Promise<void> {
  const id = safeHouseholdId(state.householdId);
  const b = backend();
  memory.set(id, structuredClone(state));
  if (b === "memory") return;
  const raw = JSON.stringify(state);
  if (b === "upstash") {
    // Demo households expire after 30 days.
    await upstash(["SET", `renewwise:${id}`, raw, "EX", 60 * 60 * 24 * 30]);
  } else {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(path.join(dir(), `${id}.json`), raw, "utf8");
  }
}

export async function reset(householdId: string): Promise<HouseholdState> {
  const s = seedHousehold(safeHouseholdId(householdId));
  await save(s);
  return s;
}

// Serialize writes per household inside one process so two tool calls can't interleave a read-modify-write.
const locks = new Map<string, Promise<unknown>>();
export async function withHousehold<T>(householdId: string, fn: (s: HouseholdState) => T | Promise<T>, write = true): Promise<T> {
  const id = safeHouseholdId(householdId);
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const state = await load(id);
    const out = await fn(state);
    if (write) await save(state);
    return out;
  });
  locks.set(id, run);
  return run;
}

// Small JSON values outside a household (the daily AI budget). Same backends as households.
const metaMemory = new Map<string, unknown>();
export async function loadMeta<T>(key: string, fallback: T): Promise<T> {
  const b = backend();
  try {
    if (b === "upstash") { const raw = await upstash(["GET", `renewwise-meta:${key}`]); if (raw) return JSON.parse(raw); }
    else if (b === "file") { return JSON.parse(await fs.readFile(path.join(dir(), `_${key}.json`), "utf8")); }
  } catch { /* fall through */ }
  return (metaMemory.get(key) as T) ?? fallback;
}
export async function saveMeta(key: string, value: unknown): Promise<void> {
  metaMemory.set(key, value);
  const b = backend();
  if (b === "upstash") await upstash(["SET", `renewwise-meta:${key}`, JSON.stringify(value), "EX", 60 * 60 * 24 * 3]);
  else if (b === "file") { await fs.mkdir(dir(), { recursive: true }); await fs.writeFile(path.join(dir(), `_${key}.json`), JSON.stringify(value), "utf8"); }
}
