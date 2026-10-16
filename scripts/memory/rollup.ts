// Memory consolidation (DAG): one parameterized script for all periods.
// Run by a systemd timer (see deploy/iva-memory-*.{service,timer}), drives Iva
// via eve/client (like scripts/daily-digest.ts), and posts a report to Telegram for daily/weekly.
//
//   node --env-file=.env scripts/memory/rollup.ts <daily|weekly|monthly|yearly>
//
// Requires: a running agent (eve start) and a vault to write into. The processing rules
// (scripts/memory/instructions/) ship with the repo. Date is in ASSISTANT_TIMEZONE.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type SessionState } from "eve/client";
import { CORE_CAP } from "../lib/core-cap.mjs";
import { notifyConfigured, sendReport } from "../lib/notify.mjs";
import { cancelTurnQuietly, resolveTurnTimeoutMs, withTurnTimeout } from "../lib/rollup-turn.mjs";

type Period = "daily" | "weekly" | "monthly" | "yearly";

const PERIODS: readonly Period[] = ["daily", "weekly", "monthly", "yearly"];
// process.argv: [node, script, <period>] — the period is the first CLI argument.
const period = process.argv[2] as Period | undefined;

if (!period || !PERIODS.includes(period)) {
  console.error(`Usage: rollup.ts <${PERIODS.join("|")}>`);
  process.exit(1);
}

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BEARER = process.env.ASSISTANT_BEARER; // needed if the prod eve channel requires auth
const VAULT = process.env.ASSISTANT_VAULT_DIR ?? "vault";
const TZ = process.env.ASSISTANT_TIMEZONE ?? process.env.TZ ?? "UTC";
// Format rules and the dbrain-processor prompts live in the repo, not in the vault: they
// are product, and must update with it instead of rotting inside every user's vault.
// Absolute, so the agent can read them whatever its working directory is.
const INSTRUCTIONS = resolve(dirname(fileURLToPath(import.meta.url)), "instructions");

// daily/weekly reports are delivered to the owner (MAX/Telegram); monthly/yearly are silent (vault only).
const POST_REPORT: Record<Period, boolean> = {
  daily: true,
  weekly: true,
  monthly: false,
  yearly: false,
};

// Current date in the user's timezone (systemd sets TZ from .env, but we hedge anyway).
function localDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Shift an ISO date (YYYY-MM-DD) by N days; arithmetic in UTC, no DST edge cases.
function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

// We take the target period as COMPLETED: timers fire at the start of a new period
// (daily ≈04:00, weekly on Sun, monthly on the 1st, yearly on Jan 1), so we process
// the PREVIOUS period, not the empty current one (now is the current local date).
function buildPrompt(p: Period, now: string): string {
  const [y, m] = now.split("-").map(Number);
  const yesterday = shiftDate(now, -1);
  const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const prevYear = String(y - 1);

  const intro =
    `You are processing long-term memory (vault: ${VAULT}). It is now ${now} (${TZ}). ` +
    `Work strictly by the format rules in ${INSTRUCTIONS}/rules/ and the dbrain-processor ` +
    `instructions in ${INSTRUCTIONS}/dbrain-processor/. ` +
    `Do not invent facts — take them from the source files. `;

  const tail =
    `At the end, return a SHORT report in plain text (no markdown tables): what was created/updated, ` +
    `key topics and links between cards. Only the finished report, with no preamble or reasoning.`;

  switch (p) {
    case "daily":
      return (
        intro +
        `Process the raw transcript of the completed day (${VAULT}/daily/${yesterday}.md): ` +
        `extract entities and create/update autograph cards. Prefer the write_card tool over write_file ` +
        `for cards — it enforces the schema. For each fact choose one operation: ADD (new), ` +
        `SUPERSEDE (contradicts a current value), or NOOP (already known). ` +
        `On SUPERSEDE: REWRITE the card's current value (frontmatter + top description) to the new fact, ` +
        `and move the OLD value to a '## History' section as a dated line (e.g. '- 2026-03→06: TDI Group'). ` +
        `Never leave two contradictory CURRENT values; History is append-only, never edited. ` +
        `Tag each fact's certainty with 'confidence:' — EXTRACTED (user stated it directly) or ` +
        `INFERRED (you deduced it). ` +
        `Emotional venting and momentary states ("I'm useless", "wasted the whole day", tiredness, ` +
        `frustration) are NEVER identity-level facts: never put them into CORE or entity cards. ` +
        `At most mention them as a dated mood line in the daily-summary, or — only if clearly worth ` +
        `keeping — a note card with status: archived. ` +
        `First read ${VAULT}/.graph/supersede-candidates.json (the deterministic conflict scan) and ` +
        `resolve every listed same-entity conflict by superseding the stale card. ` +
        `Then assemble a daily-summary for ${yesterday} with the day's topics and MOC links down to the cards ` +
        `and to the raw transcript daily/${yesterday}.md. ` +
        `Then update ${VAULT}/CORE.md per the ${INSTRUCTIONS}/rules/core-format.md rule: refresh permanent ` +
        `facts about the user, preferences, active goals (≤3), and the pointer to the last day (${yesterday}); ` +
        `keep it ≤~${CORE_CAP} characters — compress on overflow, don't bloat. ` +
        `Separately, reflect on the day's interactions: for each notable exchange judge the outcome — ` +
        `useful, dead_end, or corrected (user corrected you, asked again, or was dissatisfied). ` +
        `When a corrected/dead_end outcome reveals a REPEATABLE behavioral lesson (not a one-off fix), ` +
        `add/refine ONE dated line in the CORE Preferences section (e.g. '- 2026-07: отвечать короче, ` +
        `без преамбул') so you don't repeat it. Keep lessons recency-ordered, drop the stalest when the ` +
        `section grows; a lesson consistently honored for weeks can be dropped. Skip this whole step if ` +
        `the day held no corrections (no-op — don't invent lessons). ` +
        tail
      );
    case "weekly":
      return (
        intro +
        `Assemble a weekly-summary for the completed week (7 days ending ${yesterday}): ` +
        `read the daily-summaries of those 7 days, pull out cross-cutting topics and the week's takeaways, ` +
        `create a weekly-summary with MOC links down to those daily-summaries. ` +
        tail
      );
    case "monthly":
      return (
        intro +
        `Assemble a monthly-summary for the completed month ${prevMonth}: ` +
        `read the weekly-summaries of month ${prevMonth}, pull out the main topics and the month's takeaways, ` +
        `create a monthly-summary with MOC links down to the weekly summaries. ` +
        tail
      );
    case "yearly":
      return (
        intro +
        `Assemble a yearly-summary for the completed year ${prevYear}: ` +
        `read the monthly-summaries of year ${prevYear}, pull out the main topics and the year's takeaways, ` +
        `create a yearly-summary with MOC links down to the monthly summaries. ` +
        tail
      );
  }
}

const client = new Client({
  host: HOST,
  ...(BEARER ? { auth: { bearer: async () => BEARER } } : {}),
});

// Session REUSE, not a fresh session per night. eve backs every client session with a
// workflowEntry run in .eve/.workflow-data that nothing ever closes (the client API has
// no delete), so a fresh session per rollup leaked one forever-"running" run per night
// and eve re-enqueued the whole pile on every start. One persistent session per period
// caps that at one run. Rotation is deliberately RARE (90d): every rotation abandons one
// run in the store (nothing can close it), so frequent rotation would just re-create the
// leak. Abandoned sessions are logged to data/rollup-abandoned.jsonl for the record;
// `iva reset` clears them together with the store. Parked cursor lives in data/.
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const SESSION_FILE = join(DATA_DIR, `rollup-session-${period}.json`);
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;

function loadSession(): { state: SessionState; createdAt: number } | null {
  try {
    const j = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    if (!j?.state) return null;
    if (Date.now() - (j.createdAt ?? 0) > SESSION_TTL_MS) {
      logAbandoned(j.state, "ttl-rotation");
      return null;
    }
    return j;
  } catch {
    return null;
  }
}

// Атомарная запись (tmp + rename): курсор сессии не должен превращаться в полфайла.
function saveSession(state: SessionState, createdAt: number): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SESSION_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ state, createdAt }), "utf8");
  renameSync(tmp, SESSION_FILE);
}

// Брошенные сессии (ротация/несовместимый курсор) — в журнал: их run-обёртки остаются
// в сторе до ближайшего `iva reset`, и по журналу видно, чьи они.
function logAbandoned(state: SessionState, reason: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(
      join(DATA_DIR, "rollup-abandoned.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), period, reason, sessionId: state.sessionId ?? null }) + "\n",
      "utf8",
    );
  } catch {
    /* журнал не должен ронять ночь */
  }
}

// Ход целиком (send + result) под таймаутом: резюм припаркованной сессии после рестарта
// сервера умеет виснуть молча (#104), и без гонки с таймером ночь просто не заканчивается.
const TURN_TIMEOUT_MS = resolveTurnTimeoutMs(process.env.ROLLUP_TURN_TIMEOUT_MS, {
  warn: (message) => console.error(`rollup ${period}: ${message}`),
});
const guardedTurn = (session: ReturnType<typeof client.session>, prompt: string, label: string) =>
  withTurnTimeout(
    async () => {
      const response = await session.send(prompt);
      return await response.result();
    },
    { timeoutMs: TURN_TIMEOUT_MS, label },
  );

// Зависший ход на сервере не останавливается сам, а его курсор в SESSION_FILE описывает
// недочитанный ход: следующая ночь резюмнулась бы об него и повисла снова. Поэтому ход
// гасим, сессию помечаем брошенной и выбрасываем курсор — завтра стартуем со свежей.
async function dropHungSession(label: string): Promise<void> {
  await cancelTurnQuietly(session);
  logAbandoned(session.state, `${label}-timeout`);
  try {
    rmSync(SESSION_FILE, { force: true });
  } catch {
    /* курсор — кэш, его потеря не должна ронять ночь */
  }
}

const today = localDate();
const saved = loadSession();
let sessionCreatedAt = saved?.createdAt ?? Date.now();
let session = saved ? client.session(saved.state) : client.session();
let result;
try {
  result = await guardedTurn(session, buildPrompt(period, today), "main-turn");
} catch (e) {
  // The parked session may be gone (iva reset quarantined the store) or hung on resume —
  // fall back to a fresh one once instead of failing the night.
  const hung = (e as { code?: string }).code === "ROLLUP_TURN_TIMEOUT";
  // Выход наверх роняет процесс и отпускает .memory.lock, а зависший ход продолжает писать
  // в vault — уже без всякой защиты от параллельного роллапа. Гасим и на терминальных путях.
  if (!saved) {
    if (hung) await cancelTurnQuietly(session);
    throw e;
  }
  console.error(
    `rollup ${period}: parked session ${hung ? "hung" : "unusable"} (${(e as Error).message}) — starting fresh`,
  );
  logAbandoned(saved.state, hung ? "resume-timeout" : "unusable-cursor");
  // «Медленный», а не мёртвый ход продолжил бы писать в vault параллельно с retry — гасим его
  // до создания второго писателя (оба идут под одним флоком, конфликт не поймать иначе).
  if (!(await cancelTurnQuietly(session))) {
    // Отмена — best-effort: у заклинившей сессии она сама может не подтвердиться. Retry всё
    // равно делаем (иначе ночь без роллапа), но след для разбора полётов оставляем.
    console.error(`rollup ${period}: could not confirm cancellation of the timed-out turn — retrying anyway`);
  }
  session = client.session();
  sessionCreatedAt = Date.now();
  // Ровно одна попытка: второй сбой уходит наверх и роняет юнит с ненулевым кодом.
  try {
    result = await guardedTurn(session, buildPrompt(period, today), "main-turn");
  } catch (retryError) {
    if ((retryError as { code?: string }).code === "ROLLUP_TURN_TIMEOUT") await cancelTurnQuietly(session);
    throw retryError;
  }
}
saveSession(session.state, sessionCreatedAt);

// An interactive turn ends with status "waiting" (the session is ready for the next message),
// so we rely on the presence of text rather than a "completed" status.
if (result.status === "failed" || !result.message) {
  console.error(`rollup ${period}: agent returned no report (status=${result.status})`);
  process.exit(1);
}

// Daily is the only rollup that updates CORE. Verify the actual file, not just the turn
// status: one same-session correction is allowed, then fail loudly and leave doctor as
// the deterministic 05:00 backstop.
if (period === "daily") {
  const corePath = join(VAULT, "CORE.md");
  let core = readFileSync(corePath, "utf8");
  if (core.length > CORE_CAP) {
    const oldLength = core.length;
    console.error(
      `rollup daily: CORE.md still exceeds the cap (${oldLength}/${CORE_CAP}); requesting one correction`,
    );
    // Таймаут здесь не заводит новую сессию: это просто «коррекция не удалась» — файл
    // перечитывается как есть, и дальше срабатывает существующая проверка капа.
    try {
      await guardedTurn(
        session,
        `Re-open ${corePath}: it is ${oldLength} characters, above the hard ${CORE_CAP}-character cap. ` +
          "Compress it now per the core-format rule. Preserve every heading and the Pointers/Указатели " +
          "section; remove stale Preferences/Предпочтения first. Do not return until the file itself is within the cap.",
        "core-correction",
      );
      saveSession(session.state, sessionCreatedAt);
    } catch (e) {
      console.error(`rollup daily: CORE.md correction turn failed (${(e as Error).message})`);
      if ((e as { code?: string }).code === "ROLLUP_TURN_TIMEOUT") await dropHungSession("core-correction");
    }
    core = readFileSync(corePath, "utf8");
    if (core.length > CORE_CAP) {
      console.error(
        `rollup daily: CORE.md remains over cap after one correction (${core.length}/${CORE_CAP}); ` +
          "doctor will clamp it at 05:00",
      );
      process.exit(1);
    }
    console.log(`rollup daily: CORE.md compressed ${oldLength} → ${core.length} chars`);
  }
}

console.log(`rollup ${period} (${today}):\n${result.message}`);

// Report only for daily/weekly. An unconfigured channel is NOT an error: the rollup itself
// (memory, vault) already succeeded and must not depend on delivery.
if (POST_REPORT[period]) {
  if (!notifyConfigured()) {
    console.error(`rollup ${period}: no notification channel configured — report not sent (vault updated)`);
    process.exit(0);
  }
  const r = await sendReport(result.message);
  if (r.fellBack) {
    // HTML didn't parse — the report went out flat. Give the agent feedback in the same
    // session so it formats the next report more simply (one turn, no resend).
    // ВАЖНО: дождаться конца хода и пересохранить курсор — иначе следующий ночной send
    // поедет со старым continuation-токеном недочитанного хода.
    // Best-effort ход: отчёт уже доставлен, поэтому сбой или таймаут здесь только логируем —
    // ронять из-за подсказки о форматировании всю ночь незачем.
    try {
      await guardedTurn(
        session,
        `The last report failed ${r.channel} formatting (${r.error}) and went out as flat text. ` +
          "Next time format it more simply: **bold**, `code`, lists — no raw HTML.",
        "format-feedback",
      );
      saveSession(session.state, sessionCreatedAt);
    } catch (e) {
      console.error(`rollup ${period}: format-feedback turn failed (${(e as Error).message})`);
      if ((e as { code?: string }).code === "ROLLUP_TURN_TIMEOUT") await dropHungSession("format-feedback");
    }
  }
  if (!r.ok) {
    console.error(`rollup ${period}: ${r.channel} send failed:`, r.error);
    process.exit(1);
  }
  console.log(`rollup ${period}: report sent via ${r.channel}.`);
}

process.exit(0);
