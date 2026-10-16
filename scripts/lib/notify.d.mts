export interface NotifyResult {
  ok: boolean;
  fellBack: boolean;
  error: string;
  channel: "max" | "telegram" | null;
  configured: boolean;
}
export type NotifyTarget =
  | { channel: "max"; token: string; userId: string }
  | { channel: "telegram"; token: string; chatId: string }
  | { channel: null };
export interface NotifyOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  caption?: boolean;
  plain?: boolean;
}
export function maxRecipient(env?: Record<string, string | undefined>): string;
export function notifyTarget(env?: Record<string, string | undefined>): NotifyTarget;
export function notifyConfigured(env?: Record<string, string | undefined>): boolean;
export function sendReport(md: string, opts?: NotifyOptions): Promise<NotifyResult>;
export function sendNotice(text: string, opts?: NotifyOptions): Promise<NotifyResult>;
export function sendUpdateOfferVia(opts: {
  env?: Record<string, string | undefined>;
  offer: { text: string; replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
  fetchImpl?: typeof fetch;
}): Promise<unknown>;
