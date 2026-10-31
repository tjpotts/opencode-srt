# OpenCode SRT Sandbox

An OpenCode V2 server plugin that runs every OpenCode shell command through
[Anthropic Sandbox Runtime (SRT)](https://github.com/anthropic-experimental/sandbox-runtime).

## Requirements

This plugin has the same runtime prerequisites as its pinned
[SRT dependency](https://github.com/anthropic-experimental/sandbox-runtime#platform-specific-dependencies); it adds none of its own. On Linux, this includes:

- Node.js 22.12 or later
- `bubblewrap`, `socat`, and `ripgrep` on `PATH`
- A host configuration that permits the user namespaces required by Bubblewrap
- An SRT settings file. Commands are blocked when it is missing, unreadable,
  invalid JSON, or invalid SRT configuration.

## Install

Build the package, then add it to the OpenCode configuration for the project:

```sh
npm install
npm run build
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./path/to/opencode-srt"]
}
```

Use a project-local plugin during development by placing this package under
`.opencode/plugins/`.

## Configuration

By default the plugin reads `srt-settings.json` in OpenCode's global
configuration directory when it exists: `$XDG_CONFIG_HOME/opencode/` when
`XDG_CONFIG_HOME` is set, otherwise `~/.config/opencode/`. It then falls back
to `~/.srt-settings.json`. It fails closed if neither file exists.

Set `settingsPath` to select another file:

```jsonc
{
  "plugins": [
    {
      "package": "./path/to/opencode-srt",
      "options": {
        "settingsPath": ".opencode/srt-settings.json",
        "nodePath": "/usr/bin/node"
      }
    }
  ]
}
```

An absolute path or `~/…` is used as written. A relative `settingsPath` is
resolved from the active project/worktree root.

`nodePath` is optional. By default the plugin finds `node` on `PATH`; set it
when OpenCode runs with a PATH that does not expose the Node.js 22 runtime
needed by SRT.

SRT filesystem entries in `denyRead`, `allowRead`, `allowWrite`, and
`denyWrite` are also resolved from that root. Therefore `"."` always means
the current project/worktree, even when OpenCode executes a command from a
nested directory. Absolute and `~/…` paths retain their normal SRT meaning.

The selected settings file is always appended to `filesystem.denyWrite` as a
literal path, preventing a sandboxed command from modifying the policy that
governs it.

## How it works

When OpenCode creates a shell command, the plugin records the original shell,
command, working directory, project root, and selected settings path in an
environment payload. It then substitutes a shell-named wrapper executable.
The wrapper starts the Node runtime helper, which reads and validates the SRT
policy, anchors relative filesystem entries at the project root, and runs the
original command inside SRT.

The plugin replaces the shell executable rather than rewriting the command.
That leaves OpenCode's permission analysis looking at the original command.
The wrapper keeps the original shell's basename (for example, `bash` or
`powershell`) so OpenCode selects the correct shell grammar; the build therefore
includes a wrapper for every supported shell.

Example policy:

```json
{
  "network": {
    "allowedDomains": [],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh"],
    "allowRead": [],
    "allowWrite": ["."],
    "denyWrite": [".env"]
  }
}
```

## Security and scope

- There is no unsandboxed fallback.
- Each command launches a separate Node helper, preventing SRT's process-wide
  manager state from being shared between projects or worktrees.
- The original command and shell are retained for OpenCode's shell permission
  analysis; the plugin substitutes only the executable that hosts the helper.
- This covers OpenCode shell commands, including shell messages. It does not
  sandbox OpenCode file tools, MCP servers, or processes launched directly by
  other plugins.
- SRT is a beta research preview. This package pins its version; update it
  deliberately and rerun the test suite.

## Development

```sh
npm install
npm run build
npm run check
npm test
```

The project `shell.nix` provides Node.js 22 and Bubblewrap for Nix users.

Tests are compiled from `src/**/*.test.ts` into `dist/` and run with Node's
built-in test runner. They cover policy-path normalization and other helper
logic that does not require starting a sandbox.
