import { Plugin } from "@opencode/plugin"
import { AsyncLocalStorage } from "node:async_hooks"
import { basename, delimiter, isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import { accessSync, constants, existsSync } from "node:fs"
import { FALLBACK_SHELL_NAME, SUPPORTED_SHELL_NAMES } from "./shells.js"

/**
 * OpenCode hook that replaces the requested shell with a shell-named wrapper.
 * The wrapper starts the runtime helper, which loads the SRT policy and runs
 * the original shell command inside the sandbox.
 */
const PAYLOAD_ENV = "OPENCODE_SRT_PAYLOAD"
const NODE_ENV = "OPENCODE_SRT_NODE"
const BYPASS_PERMISSION = "unsafe_shell"

type UnsafeShellInvocation = {
  command: string
  cwd: string
  available: boolean
}

type ShellInput = {
  command: string
  workdir?: string
  timeout?: number
  background?: boolean
}

type UnsafeShellInput = ShellInput & {
  reason: string
}

const UNSAFE_SHELL_INPUT = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command string to execute" },
    reason: {
      type: "string",
      minLength: 1,
      description: "Why this command must run outside SRT instead of using the sandboxed shell tool",
    },
    workdir: { type: "string", description: "Working directory to execute the command in" },
    timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds; 0 disables it" },
    background: { type: "boolean", description: "Run the command in the background" },
  },
  required: ["command", "reason"],
  additionalProperties: false,
} as const

// The native shell executor and the shell hook run in the same async call
// chain. This makes approval local to one tool invocation, rather than a
// process-wide switch that another session or concurrent command could use.
const unsafeShellInvocation = new AsyncLocalStorage<UnsafeShellInvocation>()

type PluginOptions = {
  settingsPath?: unknown
  nodePath?: unknown
}

export function resolveDefaultSettingsPath(
  homeDirectory = homedir(),
  pathExists = existsSync,
  configHome = process.env.XDG_CONFIG_HOME || join(homeDirectory, ".config"),
): string {
  const opencodeSettings = join(configHome, "opencode", "srt-settings.json")
  return pathExists(opencodeSettings) ? opencodeSettings : join(homeDirectory, ".srt-settings.json")
}

export function resolveSettingsPath(options: PluginOptions, projectRoot: string): string {
  if (options.settingsPath === undefined) return resolveDefaultSettingsPath()
  if (typeof options.settingsPath !== "string" || options.settingsPath.length === 0)
    throw new Error("opencode-srt: settingsPath must be a non-empty string")
  const expanded = options.settingsPath === "~" ? homedir() : options.settingsPath.replace(/^~\//, `${homedir()}/`)
  return resolve(projectRoot, isAbsolute(expanded) ? expanded : join(projectRoot, expanded))
}

function wrapperPathFor(shell: string): string {
  const shellName = basename(shell)
  // Keep the helper's basename equal to the original shell where possible.
  // OpenCode's permission scanner selects its grammar from this basename.
  const wrapperName = SUPPORTED_SHELL_NAMES.includes(shellName as (typeof SUPPORTED_SHELL_NAMES)[number])
    ? shellName
    : FALLBACK_SHELL_NAME
  return new URL(`./runtime/bin/${wrapperName}`, import.meta.url).pathname
}

function resolveNodePath(options: PluginOptions, projectRoot: string): string {
  if (options.nodePath !== undefined) {
    if (typeof options.nodePath !== "string" || options.nodePath.length === 0)
      throw new Error("opencode-srt: nodePath must be a non-empty string")
    return isAbsolute(options.nodePath) ? options.nodePath : resolve(projectRoot, options.nodePath)
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, "node")
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue looking; the wrapper will fail closed if no Node runtime exists.
    }
  }
  return "node"
}

export default Plugin.define({
  id: "srt",
  async setup(ctx) {
    if (process.platform !== "linux") throw new Error("opencode-srt supports Linux only")

    const projectRoot = ctx.location.project.directory
    const selectedSettings = resolveSettingsPath(ctx.options as PluginOptions, projectRoot)
    const selectedNode = resolveNodePath(ctx.options as PluginOptions, projectRoot)

    await ctx.permission.hook("evaluate", (event) => {
      if (event.action !== BYPASS_PERMISSION) return
      event.effect = "ask"
      event.message = "This command will be run outside the SRT sandbox."
    })

    await ctx.shell.hook("create.before", (event) => {
      const bypass = unsafeShellInvocation.getStore()
      if (bypass?.available && bypass.command === event.command && bypass.cwd === event.cwd) {
        bypass.available = false
        return
      }

      const originalShell = event.shell
      event.env[PAYLOAD_ENV] = Buffer.from(
        JSON.stringify({
          command: event.command,
          shell: originalShell,
          commandCwd: event.cwd,
          projectRoot,
          settingsPath: selectedSettings,
        }),
      ).toString("base64url")
      event.env[NODE_ENV] = selectedNode
      event.shell = wrapperPathFor(originalShell)
    })

    await ctx.tool.transform((editor) => {
      const shell = editor.get("shell")
      if (!shell) throw new Error("opencode-srt: OpenCode's native shell tool is unavailable")

      editor.add({
        name: "unsafe_shell",
        description:
          "Run a shell command outside the SRT sandbox. Use only when the sandbox prevents a necessary action. You MUST provide a specific reason why unsafe_shell is necessary instead of the sandboxed shell tool. Every call requires explicit user approval and still follows OpenCode's normal shell permission checks.",
        input: UNSAFE_SHELL_INPUT,
        ...(shell.output === undefined ? {} : { output: shell.output }),
        options: { codemode: false, permission: BYPASS_PERMISSION },
        execute: async (input, context) => {
          const unsafeInput = input as UnsafeShellInput
          const { reason, ...shellInput } = unsafeInput
          if (reason.trim().length === 0) throw new Error("unsafe_shell requires a non-blank reason")
          const cwd = shellInput.workdir ?? ctx.location.directory
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: BYPASS_PERMISSION,
            resources: [shellInput.command],
            // Bypassing the sandbox is always a fresh decision, even when the
            // user selects the client's "always" approval option.
            save: [],
            metadata: { command: shellInput.command, cwd, reason, sandbox: "bypassed" },
          })

          return unsafeShellInvocation.run(
            { command: shellInput.command, cwd, available: true },
            () => shell.execute(shellInput, context),
          )
        },
      })
    })
  },
})
