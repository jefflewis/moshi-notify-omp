# moshi-notify-omp

Oh My Pi extension that bridges agent lifecycle events to the [Moshi](https://getmoshi.app) API for iOS push notifications and Live Activity updates.

```
Oh My Pi  →  moshi-notify-omp  →  Moshi API  →  APNs  →  Live Activity
```

## Install

Requires [Bun](https://bun.sh) (>= 1.0.0).

1. Copy into your Oh My Pi extensions directory:

```bash
git clone https://github.com/jefflewis/moshi-notify-omp.git ~/Developer/moshi-notify-omp
cp ~/Developer/moshi-notify-omp/src/extension.ts ~/.omp/agent/extensions/moshi-notify.ts
```

2. Set your Moshi API token:

```bash
mkdir -p ~/.config/moshi
echo "YOUR_TOKEN" > ~/.config/moshi/token
```

3. Restart Oh My Pi.

## How it works

Only todo updates and critical messages are sent — everything else is silent.

| Event | When it fires | Title example |
|---|---|---|
| `tool_call` / `tool_result` | Only for `todo_write` | `Implementation · 2/7` |
| `turn_end` | Assistant is asking for user input (question/approval) | `rev-market:agent · Waiting for Reply` |
| `auto_retry_start` | Agent retries after an error | `rev-market:agent · Retrying` |

### Noise reduction

- **No start/end pings** — `agent_start` and `agent_end` are not sent.
- **No tool spam** — `bash`, `read`, `edit`, etc. are silent. Only `todo_write` updates the Live Activity.
- **Tight question filter** — `turn_end` only notifies when the assistant is genuinely asking for input (explicit questions, approval phrases), not when it mentions "error" or "warning" in passing.

### Tmux context

When running inside tmux, the notification title includes `session:window` (e.g. `rev-market:agent`) so you know which project the agent is working on.

## Privacy

No secrets are embedded in the source. The Moshi API token is read at runtime from `~/.config/moshi/token`. The only external dependency is the Moshi API endpoint (`https://api.getmoshi.app/api/v1/agent-events`).
