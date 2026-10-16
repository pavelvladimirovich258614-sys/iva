// Дописывает реплику в дневной файл vault (формат d_brain: `## HH:MM [type]` + контент).
// Append-only: существующие записи не переписываются. Нужен каналам, чтобы ночная память
// (rollup/doctor) видела обе стороны диалога независимо от мессенджера.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function appendDaily(type: string, content: string, env: Record<string, string | undefined> = process.env): string {
  const tz = env.ASSISTANT_TIMEZONE || undefined;
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const dir = join(env.ASSISTANT_VAULT_DIR || "vault", "daily");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  appendFileSync(path, `\n## ${hhmm} ${type}\n${content}\n`, "utf8");
  return path;
}
