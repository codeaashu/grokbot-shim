# grokbot-shim

Run the Grok Bot desktop agent locally with a local computer desktop and a
configurable model backend.

The project connects the installed Grok Bot UI to its own local host runtime,
translates the app's inference protocol to supported model providers, and runs
the Computer environment on the same machine. The user can watch or take over
the desktop through noVNC.

The repository does not include application binaries. Setup extracts the
required runtime files from the user's installed copy of Grok Bot.

## Status

Working on Linux:

- local Grok Bot login and agent lifecycle;
- streamed text, reasoning state, and tool calls;
- Codex OAuth through an existing `codex login` session;
- OpenAI-compatible `/chat/completions` providers;
- model selection in the app's Settings screen;
- a local Chrome/XFCE Computer desktop with screenshots, input, and noVNC
  takeover.

This relies on undocumented integration points and may require updates when
the desktop application changes.

## Requirements

- Linux with the Grok Bot desktop application installed;
- Node.js 22.12 or newer;
- Docker with a running daemon;
- OpenSSL and curl;
- an existing `codex login` session for Codex OAuth models, or an API key for
  an OpenAI-compatible provider.

The default paths expect the executable at `/opt/Grok Bot/sand`. Override
`GROKBOT_APP` and `GROKBOT_RESOURCES` when the application is installed
elsewhere.

## Quick start

```bash
git clone <your-repository-url>
cd grokbot-shim
npm ci
npm run setup
cp .env.example .env       # optional; add provider keys if needed
./run-all.sh
```

`npm run setup` generates a local TLS certificate and extracts the required
host runtime from your installed copy of Grok Bot. Those generated files stay
outside Git.

The first Computer start downloads a pinned container image of several
gigabytes. Once running, the desktop takeover page is available only on the
local machine at <http://127.0.0.1:6080/vnc.html>.

Check prerequisites at any time:

```bash
npm run doctor
```

## What runs locally

```text
Grok Bot UI ──► host gateway (:8550) ──► backend shim (:8443) ──► model
     │                  │
     │                  └── agent loop, shell, files, and tools
     │
     └── Computer container (:6080 noVNC, :1337 exec/health)
```

- `run-recon.sh` starts the desktop UI with an isolated profile in `appdata/`.
- `run-host.sh` starts the host runtime extracted from the installed app.
- `shim/server.mjs` handles local authentication, model metadata, experiments,
  and Connect-protocol inference streaming.
- `computerctl.sh` manages the local Computer desktop container.

All published services bind to `127.0.0.1` by default. Do not expose them to
an untrusted network.

## Model configuration

Models shown by the app are declared in `models.json`. The tracked default is
GPT-5.6 Luna through Codex OAuth with Max reasoning:

```json
{
  "default": "GPT-5.6-Luna (Codex)",
  "models": {
    "GPT-5.6-Luna (Codex)": {
      "provider": "codex-oauth",
      "model": "gpt-5.6-luna",
      "reasoning_effort": "max"
    },
    "Example API model": {
      "provider": "openai-compatible",
      "base_url": "https://openrouter.ai/api/v1",
      "model": "provider/model-id",
      "env_key": "OPENROUTER_API_KEY"
    }
  }
}
```

Never put API keys directly in `models.json`. Put them in `.env`, which is
ignored by Git:

```dotenv
OPENROUTER_API_KEY=your-key-here
```

Provider support:

- `codex-oauth` uses the ChatGPT subscription session stored by `codex login`;
- `openai-compatible` uses a streaming `/chat/completions` API;
- `canned` is an offline response stub for protocol testing.

The optional `fallback` field names another model entry to use if a Codex
request is rejected because authentication or quota is unavailable.

## Commands

```bash
./run-all.sh                 # start Computer, shim, host, and desktop app
./computerctl.sh status      # inspect the Computer container
./computerctl.sh open        # open the noVNC takeover page
./computerctl.sh logs        # show recent Computer logs
./shimctl.sh status          # inspect the backend shim
./shimctl.sh restart         # restart the backend shim
npm run check                # syntax validation
npm test                     # unit tests
```

For debugging, components can be started separately in different terminals:

```bash
./computerctl.sh start
./shimctl.sh restart
./run-host.sh
./run-recon.sh
```

## Repository layout

- `shim/` — protocol definitions, inference adapters, model picker, and server;
- `scripts/setup.sh` — local certificate generation and app-runtime extraction;
- `scripts/doctor.sh` — prerequisite and generated-file checks;
- `models.json` — credential-free model catalog;
- `computerctl.sh` — Computer container lifecycle;
- `run-*.sh` — stack launchers;
- `test/` — unit tests.

The following are intentionally not versioned: the extracted `host/` runtime,
TLS keys and certificates, `appdata/`, `state/`, `logs/`, `node_modules/`, and
`.env`.

## How inference translation works

The host sends `aiserver.v1.InferenceService/Stream` requests using the Connect
protocol and binary protobuf messages. The shim decodes messages and the
agent's tool schema, calls the configured provider, and streams compatible
response frames back.

Assistant text inside the host loop is private working text. To communicate
with the user, a model must call the `SendMessage` tool supplied in the request.
For that reason, provider models need reliable function calling, not only text
generation.

## Troubleshooting

The Computer panel draws nothing (an empty frame under "<agent>'s screen") when
the desktop app is started without `--no-sandbox` on its command line. The
preview is an Electron `<webview>` on the box's noVNC page and the app marks that
guest sandboxed, while its own in-process `no-sandbox` switch is applied too late
to reach the guest. The half-sandboxed guest renderer cannot allocate shared
memory, aborts on `/dev/shm`, and crash-loops, so the panel stays blank even
though the box, VNC server, and noVNC endpoint are all healthy. `run-recon.sh`
passes the flag for this reason. The fingerprint in `logs/app.out` is:

```text
ERROR:base/memory/platform_shared_memory_region_posix.cc:213] Creating shared memory in /dev/shm/... failed: No such process (3)
FATAL:base/memory/platform_shared_memory_region_posix.cc:218] This is frequently caused by incorrect permissions on /dev/shm.
```

The desktop takeover page at <http://127.0.0.1:6080/vnc.html> is served straight
from the container, so it keeps working regardless of this flag and is the quick
way to tell a preview problem from a Computer problem.

## Privacy and security

- The isolated Grok Bot profile does not modify the default application
  profile.
- Agent prompts and model responses may be sent to the provider selected in
  `models.json`.
- Runtime logs can contain prompts, tool arguments, filesystem paths, and
  other sensitive data. Review and sanitize them before sharing.
- The noVNC page provides control of the Computer desktop. Keep it bound to
  loopback.

See `SECURITY.md` for vulnerability reporting guidance.

## Contributing

Contributions are welcome. Read `CONTRIBUTING.md`, run `npm run check` and
`npm test`, and confirm that no credentials or extracted application files are
included in the change.

## License

The original code in this repository is available under the ISC License. Grok
Bot, the extracted host runtime, the Computer image, and third-party model
services remain subject to their respective owners' terms and licenses.
