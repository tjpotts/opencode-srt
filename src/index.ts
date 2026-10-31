import { Plugin } from "@opencode/plugin"
import { basename, delimiter, isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import { accessSync, constants } from "node:fs"
import { FALLBACK_SHELL_NAME, SUPPORTED_SHELL_NAMES } from "./shells.js"

/**
 * OpenCode hook that replaces the requested shell with a shell-named wrapper.
 * The wrapper starts the runtime helper, which loads the SRT policy and runs
 * the original shell command inside the sandbox.
 */
const PAYLOAD_ENV = "OPENCODE_SRT_PAYLOAD"
const NODE_ENV = "OPENCODE_SRT_NODE"

type PluginOptions = {
  settingsPath?: unknown
  nodePath?: unknown
}

function resolveSettingsPath(options: PluginOptions, projectRoot: string): string {
  if (options.settingsPath === undefined) return join(homedir(), ".srt-settings.json")
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

    await ctx.shell.hook("create.before", (event) => {
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
  },
})
