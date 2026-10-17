#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { notifyConfigured, sendUpdateOfferVia } from "./lib/notify.mjs";
import { acquireUpdateLock, releaseUpdateLock } from "./lib/update-safety.mjs";
import {
  inspectUpstream,
  markVersionNotified,
  readNotifiedVersion,
  updateOffer,
} from "./lib/update-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function dataDir(root, env) {
  const configured = env.ASSISTANT_DATA_DIR || "data";
  return configured.startsWith("/") ? configured : join(root, configured);
}

export async function runDailyUpdateCheck({
  root = ROOT,
  env = process.env,
  inspectImpl = inspectUpstream,
  sendImpl = sendUpdateOfferVia,
  readStateImpl = readNotifiedVersion,
  writeStateImpl = markVersionNotified,
} = {}) {
  if (!notifyConfigured(env)) return { status: "not-configured" };

  const storage = dataDir(root, env);
  const lock = acquireUpdateLock(storage, `daily-check-${process.pid}-${Date.now()}`);
  if (!lock.ok) return { status: "update-running" };
  try {
    const info = await inspectImpl({ root });
    if (!info.hasVersionUpdate) return { status: "current", info };
    if (await readStateImpl(storage) === info.remoteVersion) return { status: "already-notified", info };

    const offer = updateOffer(info.localVersion, info.remoteVersion, env.AGENT_LANGUAGE === "ru" ? "ru" : "en");
    await sendImpl({ env, offer });
    await writeStateImpl(storage, info.remoteVersion);
    return { status: "notified", info };
  } finally {
    releaseUpdateLock(lock);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDailyUpdateCheck()
    .then((result) => {
      if (result.status === "notified") console.log(`Update notification sent: v${result.info.remoteVersion}`);
    })
    .catch((error) => {
      console.error(`Update check failed: ${error.message}`);
      process.exitCode = 1;
    });
}
