# LogViewer

Live CLI output. Monospace (code style, 20px rows), line numbers, collapsible sections per lifecycle step, and these tones: `system` (studio messages, accent), `command` ($ lines, bold), `edit` (file writes, blue), `ok`, `error`, `warn`, `tool`, `dim`.

- Auto-scrolls while the user is at the bottom; scrolling up stops following and shows "Jump to latest".
- `reconnecting` shows the amber stream-dropped bar without clearing lines.
- Secrets are redacted before they reach the client: render them as `••••••[redacted]` in a `warn` line.
