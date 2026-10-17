// VPS cron-runner: asks the agent for a morning digest and delivers it to the owner (MAX or Telegram).
// Launched from system cron (see README/implementation-notes).
//
//   0 5 * * *  cd /srv/assistant && node --env-file=.env scripts/daily-digest.ts >> /var/log/assistant-cron.log 2>&1
//
// Requires: a running agent (eve start) and a configured notification channel (see scripts/lib/notify.mjs).
import { Client } from "eve/client";
import { notifyConfigured, sendReport } from "./lib/notify.mjs";

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BEARER = process.env.ASSISTANT_BEARER; // needed if the eve channel in prod requires auth

if (!notifyConfigured()) {
  console.error("digest: no notification channel configured (set MAX_BOT_TOKEN + MAX_ALLOWED_USER_IDS, or Telegram) — nothing to send");
  process.exit(1);
}

const client = new Client({
  host: HOST,
  ...(BEARER ? { auth: { bearer: async () => BEARER } } : {}),
});

const session = client.session();
const response = await session.send(
  "Load the morning-digest skill and build the morning digest for my tasks. " +
    "Return only the finished digest text, no preamble.",
);
const result = await response.result();

// An interactive turn ends with status "waiting" (the session is ready for the next message),
// so we key off the presence of text rather than the "completed" status.
if (result.status === "failed" || !result.message) {
  console.error("Agent did not return a digest:", result.status);
  process.exit(1);
}

// Channel selection, formatting and self-heal live in the shared notify helper.
const r = await sendReport(result.message);
if (r.fellBack) {
  await session.send(
    `The last digest failed ${r.channel} formatting (${r.error}) and was sent as plain text — ` +
      "format more simply next time: **bold**, `code`, lists, no raw HTML.",
  );
}
if (!r.ok) {
  console.error(`digest: ${r.channel} send failed:`, r.error);
  process.exit(1);
}
console.log(`Digest sent via ${r.channel}.`);
