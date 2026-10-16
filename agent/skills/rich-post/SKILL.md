---
description: >-
  TELEGRAM-ONLY (unavailable when the chat channel is MAX - then answer in plain text). Send Telegram rich-media posts and reports via the bot (Bot API 10.1 sendRichMessage) - text, inline images, tables, headings, lists, quotes, collapsible blocks, formulas, collages/slideshows ALL in one message bubble. This is the REQUIRED transport for reports (see the red-banner rule in the persona). Also use when asked for a rich post, a message with images between text, a post with a table, "rich message", "картинка в середине текста". NOT for plain text replies (just answer) or simple albums.
---

# rich-post — Telegram rich messages via the bot

Send ONE message that mixes text, inline images, tables, headings, lists,
block quotes, collapsible blocks and formulas. This is `sendRichMessage`
(Bot API 10.1, June 2026), not an album.

Album (sendMediaGroup) = up to 10 media, ONE caption, no text between images.
Rich message = up to 50 media, text/tables/blocks interleaved in a single
bubble. If the user wants "картинка в середине текста" or "таблица в посте" —
this skill.

## Quick start

All paths are relative to the repo root (the agent's working directory).

```bash
python3 agent/skills/rich-post/scripts/send_rich.py --md-file /tmp/post.md
```

- Recipient: by default the message goes to `TELEGRAM_DIGEST_CHAT_ID` from
  `.env`. An explicit `--chat <id>` is accepted ONLY if the id is allowlisted
  (`TELEGRAM_ALLOWED_USER_IDS` + `TELEGRAM_DIGEST_CHAT_ID`) — the recipient of
  a report is the owner's setting, not the model's choice. Anything else is
  refused without sending.
- `--md` / `--md-file` — markdown content (`--md-file -` reads stdin).
- `--dry-run` — OFFLINE check: validates the markdown and image paths, prints
  the result; nothing is uploaded or sent. Always run this first.
- `--allow-upload` — see «Local images» below. Off by default.
- `--silent`, `--thread-id` — optional.
- Token: `$TELEGRAM_BOT_TOKEN` or the repo `.env`. There is NO `--token` flag
  (argv is visible in the process list) — don't put the token on the command line.

## Local images — read before using

Telegram accepts ONLY public URLs for rich-message media (`attach://` and
multipart upload fail with `RICH_MESSAGE_PHOTO_URL_INVALID`). So a local image
referenced as `![](file:/abs/path "caption")` must first be uploaded to a
public host. The script uses **tmpfiles.org — an anonymous PUBLIC host**:
anyone with the link can open the file while it lives there.

Because of that:

- uploads happen only with the explicit `--allow-upload` flag; without it,
  local images are an error (and `--dry-run` merely lists what WOULD be
  uploaded);
- only real media passes the gate: regular files with an image/video/audio
  extension (jpg/png/gif/webp/mp4/webm/mov/mp3/ogg/m4a), located inside the
  repo or the data dir, with no hidden dot-segment in the path. `.env`, OAuth
  json, logs, vault `.md` and any other text file are refused even with
  `--allow-upload` — a report must not be able to exfiltrate server files;
- never reference private documents as images anyway. If in doubt — don't
  upload; send text instead.

Telegram fetches and caches the media at send time, so the temp URL expiring
afterwards is fine.

## Workflow

1. **Write content** in markdown (see syntax below) to a temp file.
2. **`--dry-run`** to verify layout and image paths (offline).
3. **Send** — to the default digest chat, or an allowlisted `--chat`. For
   images add `--allow-upload` consciously (see above). Confirm with the user
   before posting anywhere beyond the current conversation.

## Markdown syntax (rich_message.markdown)

````
**bold**  __bold__  *italic*  _italic_  ~~strike~~  `code`  ==marked==  ||spoiler||
[link](https://t.me/)  [mail](mailto:a@b.c)  [user](tg://user?id=123)
![custom emoji](tg://emoji?id=5368324170671202286)
$x^2 + y^2$                      inline formula

# Heading 1 … ###### Heading 6
Paragraph text on its own lines.

```python
fenced code block with language
```

- unordered item        1. ordered item       - [ ] task   - [x] done
> block quote
> continues

![](https://host/photo.jpg)               inline image
![](https://host/photo.jpg "caption")     image with caption
![](https://host/clip.mp4 "cap")          video / audio / gif likewise

| Header 1 | Header 2 |               table (markdown)
|:---------|--------:|
| left | right |

Text with a footnote[^1].
[^1]: Footnote definition.

$$E = mc^2$$                         block formula

<details open><summary>Title **bold**</summary>
collapsible content (markdown inside)
</details>

<tg-collage>                         grid of media
![](url1) ![](url2)
</tg-collage>
<tg-slideshow> … </tg-slideshow>    swipeable media

HTML-only extras: <u>underline</u> <sub>x</sub> <sup>x</sup>
<aside>pull quote<cite>Author</cite></aside>
````

## Limits

- 32768 UTF-8 chars total (incl. emoji alt text + formula source)
- 500 blocks (nested blocks, list items, table rows, quotes, details count)
- 16 levels of nesting
- 50 media attachments total (photos + videos + audio)
- 20 columns per table

## Gotchas (learned)

- Images need a **public URL**. `attach://` and multipart upload → 400
  `RICH_MESSAGE_PHOTO_URL_INVALID`.
- Use `rich_message.markdown` OR `rich_message.html`, exactly one.
- Channels/groups: the bot must be admin with permission to send media (and
  the target still has to be allowlisted).
- The host does NOT call sendRichMessage on normal replies — this script is
  the way to send rich posts.

## Example

```bash
cat > /tmp/post.md <<'EOF'
# Заголовок отчёта

Вступительный абзац с **жирным** и [ссылкой](https://example.com).

Таблица:

| Метрика | Значение |
|:--------|--------:|
| Охват | 42k |

> цитата в конце
EOF
python3 agent/skills/rich-post/scripts/send_rich.py --md-file /tmp/post.md --dry-run
python3 agent/skills/rich-post/scripts/send_rich.py --md-file /tmp/post.md
```
