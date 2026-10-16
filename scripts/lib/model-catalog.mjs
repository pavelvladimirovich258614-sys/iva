// Provider/model/effort metadata for the /model and /think Telegram wizards.
// Static lists are suggestions only; selectable catalog providers must come from
// a successful live response. Codex also returns model-specific reasoning levels.
import { listCodexModelCatalog } from "./codex-oauth.mjs";
import {
  CANONICAL_REASONING_EFFORTS,
  FALLBACK_REASONING_EFFORTS,
} from "./reasoning-levels.mjs";

// Runtime accepts the stable protocol vocabulary. Telegram only offers the live
// model-specific subset; when the response is missing/broken it uses the conservative
// three-button fallback. `ultra` is intentionally absent from both lists.
export const EFFORTS = CANONICAL_REASONING_EFFORTS;
export const FALLBACK_EFFORTS = FALLBACK_REASONING_EFFORTS;

// A hung provider endpoint must not stall the bridge's single getUpdates loop.
const FETCH_TIMEOUT_MS = 10_000;

export class ModelCatalogError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message, { cause });
    this.name = "ModelCatalogError";
    this.code = code;
    this.status = status;
  }
}

// Тестовый/зеркальный адрес каталога: IVA_CATALOG_BASE_URL_<PROVIDER> (https; http — только loopback).
// Ключ провайдера уходит на этот адрес, поэтому «чужие» схемы и хосты отвергаются.
export function catalogBase(provider, cat = CATALOG[provider], env = process.env) {
  const raw = String(env?.[`IVA_CATALOG_BASE_URL_${String(provider).toUpperCase()}`] ?? "").trim();
  if (!raw) return cat?.base;
  const u = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error(`IVA_CATALOG_BASE_URL_${String(provider).toUpperCase()} must be https (http only for loopback)`);
  }
  return u.toString().replace(/\/+$/, "");
}

export const CATALOG = {
  ollama: {
    label: "Ollama Cloud",
    auth: "key",
    base: "https://ollama.com/v1",
    keyVar: "OLLAMA_API_KEY",
    modelVar: "OLLAMA_MODEL",
    def: "deepseek-v4-pro",
    // Mirrors the live GET /models list (checked 2026-07-28). Ollama Cloud retires tags without
    // notice — gemma3:12b went 410 on 2026-07-15 — so keep only IDs seen in the live response.
    // kimi-k3 is billed as "extra usage" on top of the plan (402 with an empty extra balance).
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "kimi-k3", "glm-5.2", "minimax-m3", "gemma4:31b", "gpt-oss:120b"],
  },
  opencode: {
    label: "OpenCode Go",
    auth: "key",
    base: "https://opencode.ai/zen/go/v1",
    keyVar: "OPENCODE_API_KEY",
    modelVar: "OPENCODE_MODEL",
    def: "deepseek-v4-pro",
    // Mirrors OPENCODE_MODELS in setup.mjs (bare IDs, no "opencode-go/" prefix).
    models: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "kimi-k3",
      "kimi-k2.7-code",
      "glm-5.2",
      "minimax-m3",
      "qwen3.7-max",
      "grok-4.5",
    ],
  },
  codex: {
    label: "OpenAI (подписка)",
    auth: "oauth",
    keyVar: null,
    modelVar: "CODEX_MODEL",
    def: "gpt-5.5",
    models: ["gpt-5.5", "gpt-5.1", "gpt-5"],
  },
  openrouter: {
    label: "OpenRouter",
    auth: "key",
    base: "https://openrouter.ai/api/v1",
    keyVar: "OPENROUTER_API_KEY",
    modelVar: "OPENROUTER_MODEL",
    def: "openai/gpt-5.1",
    // Always static (300+ live models don't fit inline buttons). Curated known-good
    // slugs only: every model here must support tool calling — Iva sends tool
    // definitions each turn (see the live test in setup.mjs for the full check).
    models: [
      "openai/gpt-5.1",
      "anthropic/claude-sonnet-4.5",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
      "moonshotai/kimi-k3",
    ],
  },
};

// Ollama Cloud and OpenCode Go both expose OpenAI-compatible reasoning_effort.
// Their /models payloads contain IDs only, so the API's common low/medium/high
// contract is the best available capability signal. Codex is richer: its live
// catalog carries a model-specific subset.
const REASONING_PROVIDERS = new Set(["ollama", "opencode", "codex"]);

export const providerSupportsReasoning = (provider) => REASONING_PROVIDERS.has(provider);
export const providerFallbackReasoningLevels = (provider) =>
  providerSupportsReasoning(provider) ? [...FALLBACK_EFFORTS] : [];

const optionsFor = (provider, models) =>
  models.map((id) => ({
    id,
    reasoningLevels: providerFallbackReasoningLevels(provider),
  }));

const validOptions = (provider, entries) => {
  if (!Array.isArray(entries)) {
    throw new ModelCatalogError("catalog_invalid", "provider returned a malformed model catalog");
  }
  const seen = new Set();
  const options = [];
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) {
      throw new ModelCatalogError("catalog_invalid", "provider returned a malformed model entry");
    }
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      reasoningLevels: Array.isArray(entry.reasoningLevels)
        ? [...entry.reasoningLevels]
        : providerFallbackReasoningLevels(provider),
    });
  }
  if (!options.length) {
    throw new ModelCatalogError("catalog_invalid", "provider returned an empty model catalog");
  }
  return options;
};

// Selectable options come only from the live provider catalog. Static lists remain
// display metadata and OpenRouter suggestions; they must never resurrect retired models.
export async function fetchModelOptions(provider, key, {
  dataDir,
  listCodexCatalog = listCodexModelCatalog,
  fetchFn = fetch,
} = {}) {
  const cat = CATALOG[provider];
  if (!cat) return [];
  try {
    if (provider === "codex") {
      const live = await listCodexCatalog(dataDir ? { dataDir } : {});
      return validOptions(provider, live);
    }
    if (cat.base && provider !== "openrouter") {
      const res = await fetchFn(`${catalogBase(provider, cat)}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        throw new ModelCatalogError("auth_rejected", `provider rejected credentials (${res.status})`, {
          status: res.status,
        });
      }
      if (!res.ok) {
        throw new ModelCatalogError("catalog_unavailable", `model catalog returned HTTP ${res.status}`, {
          status: res.status,
        });
      }
      let body;
      try {
        body = await res.json();
      } catch (cause) {
        throw new ModelCatalogError("catalog_invalid", "provider returned invalid catalog JSON", {
          cause,
        });
      }
      if (!body || typeof body !== "object" || !Array.isArray(body.data)) {
        throw new ModelCatalogError("catalog_invalid", "provider returned a malformed model catalog");
      }
      return validOptions(provider, body.data).sort((a, b) => a.id.localeCompare(b.id));
    }
  } catch (e) {
    if (e instanceof ModelCatalogError) throw e;
    throw new ModelCatalogError("catalog_unavailable", "couldn't load the live model catalog", {
      cause: e,
    });
  }
  return optionsFor(provider, cat.models); // openrouter and anything else: static curated list
}

// Compatibility for setup or future CLI consumers that only need IDs.
export async function fetchModels(provider, key, opts = {}) {
  return (await fetchModelOptions(provider, key, opts)).map((option) => option.id);
}

// Cheap key validity probe (same lenient policy as setup.mjs: network flake ⇒ accept).
// Returns null when the key looks fine, or a short human-readable reason.
export async function checkKey(provider, key) {
  const cat = CATALOG[provider];
  if (!cat?.base) return null;
  // OpenRouter has a dedicated auth-only endpoint; the others validate via /models.
  const url = provider === "openrouter" ? `${cat.base}/key` : `${cat.base}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return `провайдер отверг ключ (${res.status})`;
    return null;
  } catch {
    return null;
  }
}
