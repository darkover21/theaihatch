# theaihatch

theaihatch is a local, open-source AI coding workspace that records agent work as a human-speed, seekable animation. The bundled fixture runs without an API key or an LLM call.

![Playback surface](docs/assets/playback.svg)

## Install and run

Requires Node 22.

```sh
npm install
npm run dev --workspace @theaihatch/server
npm run dev --workspace @theaihatch/web
```

Open the Vite URL, use the fixture transport controls, or open a local folder and run the scripted workspace demo.

Provider keys are stored in the operating-system keychain. The provider layer is separate from MCP: providers access models, while MCP exposes tools and context. See `SECURITY.md` before connecting a local MCP server.

## Development

```sh
npm run typecheck
npm run lint
npm run test
npm run build
```

Supported providers are OpenAI, Anthropic, Google Gemini, and OpenAI-compatible endpoints. Gemini uses the official `@google/genai` SDK; its API key is stored in the operating-system keychain like the other provider credentials. OpenAI-compatible endpoints can be configured with a base URL and manual model name.

## Safety review demo

Open a Git workspace, save a provider key through the Provider settings panel, and enter a prompt in Agent run. Enable **Review each change** to pause before edits or **Dry run** to preview proposed file and command actions. Start the run, then resolve the pending hunk review or exact-command approval card. Review links identify the related SES event; the sidebar shows the run’s checkpoint ID and replayable terminal events.

Dry-run proposals are displayed separately from completed workspace edits. Dry-run mode never writes files or starts commands.

## License

Apache-2.0. See `CONTRIBUTING.md` and `SECURITY.md` for project processes.
