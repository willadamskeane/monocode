
<p align="center">
  <img src="public/monocode.png" alt="MonoCode" width="88" />
</p>

<h1 align="center">MonoCode</h1>

<p align="center">
  <strong>A desktop UI for your coding agents.</strong>
</p>

<p align="center">
  <img width="1680" height="1050" alt="Screenshot 2026-09-04 at 06 34 00" src="https://github.com/user-attachments/assets/2cd4a6ec-eb1e-4b45-8627-a76442ea3874" />
</p>

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Pi, omp, and fx. If they’re installed and logged in, MonoCode can run them. Tabs are sessions. The composer is the input. MonoCode does not sell tokens.

## Install

> Install and log in to at least one provider first:
>
> - [Claude Code](https://claude.com/product/claude-code) - `claude auth login`
> - [Codex](https://developers.openai.com/codex/cli) - `codex login`
> - [Cursor CLI](https://cursor.com/cli) - `agent login`
> - [Grok Build](https://docs.x.ai/build/overview) - `curl -fsSL https://x.ai/cli/install.sh | bash` then `grok login`
> - [OpenCode](https://opencode.ai) - `opencode auth login`
> - [Pi](https://pi.dev/) - `npm install -g @earendil-works/pi-coding-agent`
> - [omp](https://omp.sh) - `curl -fsSL https://omp.sh/install | sh`
> - [fx](https://fx.sh) - `curl -fsSL https://fx.sh/setup.sh | bash` then `fx login`

macOS (Apple Silicon): download [MonoCode.dmg](https://dl.usemono.dev/MonoCode.dmg), open it, drag MonoCode to Applications.

macOS (Intel): download [MonoCode_x64.dmg](https://dl.usemono.dev/MonoCode_x64.dmg), open it, drag MonoCode to Applications.

Linux (x86_64): download the `.deb` or AppImage from [GitHub Releases](https://github.com/hardbeat920/monocode/releases/latest). Install the `.deb` with `sudo apt install ./MonoCode_*.deb`, or make the AppImage executable with `chmod +x MonoCode_*.AppImage` and run it directly.

Windows (x86_64): download the NSIS installer from [GitHub Releases](https://github.com/hardbeat920/monocode/releases/latest) and run it.

## Some notes

This is very early and you should expect bugs.

Small, focused pull requests are welcome. Anything large is worth an issue first - see [CONTRIBUTING.md](CONTRIBUTING.md).

## Agent projects

The **Projects** list in the sidebar is the switcher. Opening a repository creates a workspace project (MonoCode's previous folder rail; Cursor's Open Folder). **New project** starts an initiative in that checkout: a coordinator, workers, shared context, and schedules (Cursor's [Projects](https://cursor.com/blog/projects), local-only). Multiple initiatives can share a repository.

- Open a repository to work in it, or choose **New project** for a named body of work in the same checkout.
- Give a project a goal, then start or resume its coordinator from the project overview. Delegate focused tasks to separate worker sessions; review the prepared message and choose a provider in the normal composer before sending.
- Save shared instructions and context documents. Project members receive the latest saved context and bounded excerpts from other members' completed replies on each turn, including when switching providers. The coordinator can delegate through the selected provider's native subagent tools where supported.
- Add opt-in, recurring **local subscriptions**. Each occurrence starts a fresh supervised worker using your default provider while MonoCode is open. Missed intervals are coalesced, not replayed. Workers may run in parallel in the same checkout, so review concurrent edits carefully. Errors appear in the workspace.
- Archive a project to pause its subscriptions. Deleting an agent project removes its context and schedules, but keeps its conversations and repository files.

Project metadata and context stay in MonoCode's local database; context is sent to your selected provider when a member runs. This does **not** provide cloud computers, cross-machine file synchronization, Slack/GitHub event subscriptions, or execution while MonoCode is closed. Context documents are saved reference text, not automatically synchronized repository files. Unsent drafts follow the normal session lifecycle.

Each project supports 20 context documents, 20 subscriptions, and 64 linked agents. Remove finished workers from **Agents** to make room for new or scheduled runs; their saved chats are retained.

## Build from source

Supports macOS, Linux, and Windows.

Need Node.js 20+ and a current stable Rust toolchain. On Linux, ensure standard Tauri prerequisites are installed (e.g. `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev`). On Windows, the installer bootstraps the [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) runtime when it is missing.

```bash
npm install
npm run tauri dev
```

### Ubuntu / Debian packages

On an Ubuntu/Debian workstation, the repository can install the native Tauri prerequisites and build distributable Linux packages directly:

```bash
npm run setup:linux:deb
npm ci
npm run build:linux
```

The Linux build emits `.deb` and AppImage bundles under `target/release/bundle/`.
Tauri loads `src-tauri/tauri.linux.conf.json` automatically for Linux development and builds.

### Windows packages

```bash
npm ci
npm run build:windows
```

The Windows build emits an NSIS installer under `target/release/bundle/nsis/`.
Tauri loads `src-tauri/tauri.windows.conf.json` automatically for Windows development and builds.

## License

[MIT](LICENSE). Provider names and logos are trademarks of their owners - see [NOTICE](NOTICE).
