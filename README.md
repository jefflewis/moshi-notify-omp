# moshi-notify-omp

Oh My Pi extension that bridges agent lifecycle events to the [Moshi](https://getmoshi.app) API for iOS push notifications and Live Activity updates.

```
Oh My Pi  →  moshi-notify-omp  →  Moshi API  →  APNs  →  Live Activity
```

## Install

Requires [Bun](https://bun.sh) (>= 1.0.0).

1. Clone into your Oh My Pi extensions directory:

```bash
git clone https://github.com/jefflewis/moshi-notify-omp.git \
  ~/.omp/agent/extensions/moshi-notify-omp
ln -s ~/.omp/agent/extensions/moshi-notify-omp/src/extension.ts \
  ~/.omp/agent/extensions/moshi-notify.ts
```

2. Set your Moshi API token:

```bash
mkdir -p ~/.config/moshi
echo "YOUR_TOKEN" > ~/.config/moshi/token
```

3. Restart Oh My Pi.

## How it works

| Event | When it fires | Title example |
|---|---|---|
| `agent_start` | New session begins | `rev-market:agent · Agent Started` |
| `turn_end` | Assistant finishes a turn **and** needs attention (question, approval, error) | `rev-market:agent · Reply Ready` |
| `tool_call` / `tool_result` | Only for `todo_write` | `Implementation · 2/7` |
| `auto_retry_start` | Agent retries after an error | `rev-market:agent · Retrying` |
| `agent_end` | Session ends | `rev-market:agent · All Done` |

### Noise reduction

- **No "Thinking" pings** — removed `turn_start` notifications entirely.
- **No tool spam** — `bash`, `read`, `edit`, etc. are silent. Only `todo_write` updates the Live Activity.
- **Filtered turn ends** — only notifies when the assistant asks a question, requests approval, or reports an error/warning/blocker.

### Tmux context

When running inside tmux, the notification title includes `session:window` (e.g. `rev-market:agent`) so you know which project the agent is working on.

## Privacy

No secrets are embedded in the source. The Moshi API token is read at runtime from `~/.config/moshi/token`. The only external dependency is the Moshi API endpoint (`https://api.getmoshi.app/api/v1/agent-events`).
