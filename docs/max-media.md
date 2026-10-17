# MAX: voice, photos, documents and files

Iva receives voice messages, photos, screenshots and documents from MAX, understands them, and sends
finished files back as real MAX attachments. It is the **same agent** as everywhere else (same memory,
tasks, skills, MCP and model provider) — only the transport layer is new. Telegram is not required.

> **Status.** Implemented and covered by contract, security and end-to-end tests on a really built Eve
> with *mock* MAX / speech / vision services (CI). **Not yet verified against a real MAX bot** — see
> [Live test](#live-test-with-a-real-max-bot) and do not rely on it before it has been done.

## What works

| You send | Iva does | Needs |
|---|---|---|
| Voice message / audio file | Downloads it, transcribes it, treats the transcript as **your own words** (so “remind me tomorrow at ten…” creates a real task via the usual `tasks` tool) | `DEEPGRAM_API_KEY` (or the transcription MAX attaches to the audio) |
| Photo / screenshot (several allowed) | Downloads it, checks that it really is an image, describes it (incl. text on it) with the provider's vision model, keeps your caption | a vision model of the current provider (same as in Telegram) |
| PDF, DOCX, XLSX, PPTX, TXT, CSV, Markdown | Detects the real format, extracts the text (sheets, numbers and formulas for XLSX, tables for DOCX), stores the file in `vault/attachments/<date>/`, lets the agent work on it | `pdftotext` (poppler-utils) for PDF |
| Scanned PDF | First pages are rendered (`pdftoppm`) and read by the vision model (OCR); if that is impossible you are told so — an empty extraction is never reported as success | `pdftoppm` + vision model |
| Video | Downloads the smallest MP4 variant through `GET /videos/{token}`, transcribes the speech. **No frame analysis** (no video-capable model path in Iva) | `DEEPGRAM_API_KEY` |
| Reply / forward | Text of the quoted message is passed as *untrusted data*; its attachments are processed too | — |
| “Make an Excel report and send it” | The agent creates the file with its usual tools and calls `max_send_file`; you get a real attachment in the chat | — |

Unsupported or not automatically readable (stated explicitly to you, nothing invented): archives
(not unpacked), executables, legacy `.doc/.xls/.ppt` (saved, but the agent must convert them), encrypted
files, files over the limits, expired links, stickers/contacts/locations/links (ignored with a note).

## Pipeline

```
MAX → webhook / polling → bridge → secret → allow-list → dedup → job written to disk → HTTP 200
   → (background) safe download → real-type check → save to vault → STT / vision / text extraction
   → ONE message to the agent (caption + labelled context) → agent turn → reply / files → MAX
```

* The access check happens **before** any download. A stranger's attachment is never fetched.
* `HTTP 200` for a webhook is returned only after the job is durably stored (`data/max/media-jobs.json`);
  if it cannot be stored, MAX gets `5xx` and redelivers.
* If the process dies while an attachment is being processed, after the restart the user receives
  “the service was restarted while I was processing your attachment, please send it again”. Nothing is
  silently dropped and nothing is silently re-run. Delivery is **at-least-once** up to the stored job and
  *at-most-once, or reported* afterwards. There is no exactly-once guarantee (MAX has no idempotency key
  for `POST /messages`, and the Eve run and the dedup record are separate writes).
* The caption is always passed to the agent together with the extracted content. A message that has only an
  attachment starts a turn too. A caption such as `/new` sent *with* a file is a request to the agent,
  not a command.

## Security

* **SSRF:** attachment links come from the network, so they are untrusted. Only `https`; the host is
  resolved by our own lookup and the connection is made **only to public addresses**, checked at connect
  time (no DNS-rebinding window); literal IPs are checked up front; every redirect is re-validated (max 3);
  loopback, RFC1918, link-local (cloud metadata), CGNAT, multicast, ULA and IPv4-mapped IPv6 are refused.
  `MAX_MEDIA_HOSTS` can restrict downloads to listed host suffixes (recommended once you have seen the real
  CDN host names in `iva logs`). The bot token and `Authorization` are never sent to media hosts.
* **Limits:** per-type size caps (declared size refused before downloading, real size enforced while
  streaming), total timeout, at most 10 attachments per message, streaming to disk (files are not read
  into memory for download/upload), temp files removed on every outcome and swept at start.
* **Real type, not the extension:** magic-byte detection; an `invoice.pdf` that is an executable, a
  “photo” that is text, an “image” that is a PDF are rejected. Executables and archives are refused.
  OOXML (docx/xlsx/pptx) is read in memory by a small ZIP reader with entry-count, size and ratio limits
  (zip-bomb), path-traversal and encryption checks; nothing is unpacked to disk and nothing is executed.
* **Prompt injection:** everything extracted from a file, an image, a video or a quoted message is
  wrapped as `<<<CONTENT … CONTENT>>>` / `<<<QUOTE …>>>` with an *untrusted data* label, passed through the
  security gate, flagged when it looks like an injection, and cannot close its own frame. Only the
  transcript of **your own voice message** (`<<<TRANSCRIPT`) is treated as your request (still flagged if
  it looks like an attack). The agent instructions say the same.
* **Outbound files** (`max_send_file`): only from `vault/` and `data/outbox/` (plus `MAX_SEND_ROOTS`), by
  real path (symlinks do not escape); never `.env`, keys, tokens, `codex-auth.json`, `data/max/*`;
  text files with key/token patterns are refused; executables refused; size capped (`MAX_UPLOAD_MAX_BYTES`,
  100 MB by default). The recipient is always an allow-listed user. The tool answers `queued` — meaning
  *accepted for delivery*, not *delivered*; a final failure produces a message to you.
* No secrets in logs: errors carry codes and status numbers, never URLs, tokens or file contents.

## Configuration

See `.env.example`. Minimum for voice: `DEEPGRAM_API_KEY` (`DEEPGRAM_LANGUAGE=ru` is more reliable for
Russian than `multi`). Photos use the vision model of the current provider (no extra key). PDF needs
`poppler-utils` on the server (`install.sh` installs it; otherwise `apt install poppler-utils`).

## API contract used (and what is still uncertain)

Source of truth: the official OpenAPI schema `max-messenger/api-schema`, **v0.0.33, commit
`1a4a502fab096aa3a15d83d7ea95667ffb44d2ac`** (read on 2026-10-17); API host `platform-api2.max.ru`.

Used exactly as the schema describes:

* Incoming: `Message.body.attachments[]` with `type` ∈ `image | video | audio | file | sticker | contact |
  inline_keyboard | share | location`; `image.payload.{photo_id,token,url}`, `audio.payload.{url,token}` +
  nullable `transcription`, `file.payload.{url,token}` + `filename`, `size`, `video.payload.{url,token}`
  (+ `GET /videos/{videoToken}` → `urls.mp4_*`); `Message.link.{type,sender,message}` for reply/forward;
  nullable `body.text`, `sender`, `Recipient.chat_id`; int64 ids kept as strings.
* Outgoing: `POST /uploads?type=image|video|audio|file` (`photo` is not used) → `{url, token?}`; multipart
  field `data` to that URL; `POST /messages` with `attachments:[{type, payload}]`
  (`image` → `payload.photos`, others → `payload.token`); `audio` and `file` are sent alone in a message;
  image/video/audio/file size limits from the `POST /uploads` description.

**Not specified by the schema — must be confirmed by the live test** (code handles them defensively):

1. Which host names the attachment `url` points to, and whether those URLs expire (we treat 403/404/410 as
   “link expired” and tell you).
2. Whether voice messages arrive as `audio` attachments and in which container (the sniffer accepts ogg,
   mp3, wav, m4a/aac, flac, amr, webm/mp4 containers).
3. The exact upload-response body for each type (`{"token"}` vs `{"photos":…}` vs `{"retval"}`): we accept
   `photos`, `token` from the upload response, or the `token` from `POST /uploads`, and fail loudly otherwise.
4. The error code for a not-yet-processed attachment: documented as HTTP 400 `attachment.not.ready`; any
   400 on a fresh attachment is retried a bounded number of times (≈10 attempts, backoff ≤15 s) and then
   reported.
5. The upload host may be plain `http` in some examples; we require `https`.

## Live test with a real MAX bot

Do this once, with a **separate test bot**, one owner in `MAX_ALLOWED_USER_IDS`, ideally on a VPS in Russia
behind HTTPS (webhook), then again with polling. Do not paste tokens anywhere except the server's `.env`
(`iva secret set MAX_BOT_TOKEN`). Collect evidence without personal data: event ids (`mid`), HTTP
statuses, `iva logs` excerpts, `iva max status`, resulting files.

| # | Action in MAX | Expected | Evidence |
|---|---|---|---|
| 1 | “Привет” | one reply | log line, `mid` |
| 2 | Russian voice message | `<<<TRANSCRIPT` in `iva logs`/daily note equals what you said; reply | daily note |
| 3 | Voice: “Ива, завтра в десять утра напомни позвонить клиенту и подготовить коммерческое предложение” | task in `/tasks` | `/tasks` output |
| 4 | Photo of text | description contains the text | reply |
| 5 | Screenshot of an error + “найди причину” | meaningful answer about *that* error | reply |
| 6 | PDF with known paragraphs | paragraphs quoted correctly | reply |
| 7 | DOCX with a table | table content correct | reply |
| 8 | XLSX with two sheets + formula | values and totals correct | reply |
| 9 | “Создай Excel/CSV-отчёт и пришли файл” | a file attachment opens in the chat | file in chat |
| 10 | “Пришли картинку/PDF из vault” | attachment opens | file in chat |
| 11 | Message with several attachments | each handled | reply |
| 12 | `/menu`, `/model`, a button, `/help`, `/usage`, a notification | unchanged behaviour | screenshots |
| 13 | `iva restart` while a large file is processing | explicit “restarted, send again” notice, no duplicate | logs |
| 14 | Message with a file from another account | nothing happens, no download in logs | `iva logs` |
| 15 | Block the network to MAX for a minute while a reply is queued | delivery resumes or a dead-letter is reported (`iva max status`) | status output |

Record the real attachment host names (step 4–8) and set `MAX_MEDIA_HOSTS` afterwards.
