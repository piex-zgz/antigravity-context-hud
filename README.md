# Context HUD — Antigravity Sidecar Plugin

An always-on, zero-token side-pane HUD and offline cross-session **Trace MRI** for **Google Antigravity**.

Stop typing *"what's my context level?"* into chat (which burns a full model turn and interrupts your flow). **Context HUD** sits quietly in Antigravity's right Auxiliary Pane alongside Artifacts and Terminals, updating every 3 seconds directly from local transcript logs — **0 LLM tokens, 0 third-party dependencies, 100% local**.

---

## Features

### 1. Live HUD (实时水位)
- **Live Context Gauge**: Real-time fill percentage (`tokens / 512K`), peak tokens, health status (`GREEN` / `YELLOW` / `RED`), and threshold markers (`75%` / `85%`).
- **Token Sparkline**: Step-by-step context growth curve with vertical compaction checkpoint markers (`G1`, `G2`, …).
- **Key Health Signals**: Compaction generation (`G`), recent 40-step non-zero shell failures (wire-anchored so exit-0 commands printing error logs never false-positive), tool actions per user turn, and total steps.
- **One-Click Deterministic Handoff (一键导出干净交接包)**: Exports a zero-LLM-rewriting Markdown handoff packet to `<brain>/<convId>/scratch/handoff-*.md` with verbatim `<USER_REQUEST>` history, secret & URL query-param redaction, checkpoint page-fault index, and touched workspace files — plus buttons to copy the path, copy a starter prompt, or launch a fresh conversation directly.
- **Hotspot & Failure Feed**: Lists frequently edited files in the current session (flagging rework churn `>= 4` edits) and the latest real shell failures.

### 2. Trace MRI (轨迹体检)
- **Zero-Invasion Cross-Session Diagnostics**: Offline scan across your recent main conversations (`7d` / `30d` / `all`), automatically skipping subagent logs.
- **Friction & Pushback Distribution**: Categorizes verbatim user pushback turns into four plain-language buckets (*readability/jargon*, *over-engineering/drift*, *fake-green/missed bugs*, *workflow friction*), with click-to-filter quotes and click-to-jump directly back to the original conversation.
- **Cross-Session Rework Hotspots**: Surfaces files edited repeatedly across sessions.
- **Exportable Markdown Report**: One-click copy of a structured Markdown diagnostic summary for retrospectives.

---

## Installation

### Option 1: One-Line Install (Recommended)

Requires `git` and `node` (>= 20). Installs the plugin into `~/.gemini/config/plugins/context-hud` and safely enables the plugin + sidecar in `~/.gemini/config/config.json` (preserving file mode `0600` and all existing settings):

```bash
curl -fsSL https://raw.githubusercontent.com/piex-zgz/antigravity-context-hud/main/install.sh | bash
```

### Option 2: Manual / Git Clone

```bash
git clone https://github.com/piex-zgz/antigravity-context-hud.git ~/.gemini/config/plugins/context-hud
~/.gemini/config/plugins/context-hud/install.sh
```

Or with Antigravity CLI:

```bash
agy plugin install https://github.com/piex-zgz/antigravity-context-hud
```

> **Important note on Sidecars**: By Antigravity's security model, third-party sidecars stay disabled until explicitly enabled. If you install manually without running `install.sh`, make sure `~/.gemini/config/config.json` includes:
>
> ```json
> {
>   "plugins": {
>     "context-hud": { "enabled": true }
>   },
>   "sidecars": {
>     "context-hud/context_hud": { "enabled": true }
>   }
> }
> ```

### Opening the Panel

1. Antigravity typically hot-starts the sidecar right after `config.json` updates (if it doesn't appear in the menu yet, restart Antigravity once).
2. In any conversation, click **`+`** at the top of the right **Auxiliary Pane** and pick **`Context HUD`**.

---

## Standalone Browser Preview

You can also inspect your local transcripts in any browser without launching Antigravity:

```bash
node sidecars/context_hud/main.mjs --standalone --port 4310
# Open http://127.0.0.1:4310/?conversationId=<your-conversation-uuid>
```

---

## Configuration

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `CONTEXT_HUD_COMPACTION_CLIFF` | `512000` | Token denominator used for the fill-level gauge |

---

## Privacy & Security

- **100% Local**: Reads only `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript*.jsonl` on loopback (`127.0.0.1`). Makes zero outbound network calls.
- **Secret Redaction**: Strips URL query strings, JWTs, `Bearer` tokens, API keys (`sk-`, `ghp_`, `gho_`, `AKIA`, …), and inline credential assignments before displaying quotes or writing handoff files.
- **Read-Only by Default**: Only writes a Markdown file inside Antigravity's own `<brain>/<convId>/scratch/` directory when you explicitly click **Export Handoff**.

---

## Development & Tests

Zero `npm install` required — uses Node's built-in test runner:

```bash
node --test tests/test_sidecar.mjs
```

## Uninstall

```bash
~/.gemini/config/plugins/context-hud/install.sh --uninstall
```
