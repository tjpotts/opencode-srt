import { spawn } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SandboxManager, SandboxRuntimeConfigSchema, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"

/**
 * Runtime entry point launched by the shell-named wrapper. It decodes the
 * command supplied by the plugin, prepares an SRT policy rooted at the active
 * worktree, then runs the original shell command in a fresh sandbox.
 */
type SandboxInvocation = {
  command: string
  shell: string
  commandCwd: string
  projectRoot: string
  settingsPath: string
}

type FilesystemPathEntry = string | { path: string; literal: true }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runSandboxInvocation().catch(reportFailure)
}

async function runSandboxInvocation(): Promise<void> {
  const encodedPayload = process.env.OPENCODE_SRT_PAYLOAD
  if (!encodedPayload) throw new Error("missing sandbox invocation payload")

  const invocation = parseInvocationPayload(encodedPayload)
  const config = await loadConfig(invocation)
  const command = `${quoteForShell(invocation.shell)} -c ${quoteForShell(invocation.command)}`
  const callerCwd = process.cwd()
  process.chdir(invocation.projectRoot)
  try {
    await SandboxManager.initialize(config)
    const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/sh")
    process.exitCode = await runCommand(wrapped, invocation.commandCwd)
  } finally {
    process.chdir(callerCwd)
    // SRT manager state is process-wide; each invocation must leave none behind.
    await SandboxManager.reset()
  }
}

export function parseInvocationPayload(value: string): SandboxInvocation {
  try {
    const data: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (
      !data ||
      typeof data !== "object" ||
      !Object.values(data).every((item) => typeof item === "string")
    )
      throw new Error("invalid payload")
    return data as SandboxInvocation
  } catch {
    throw new Error("invalid sandbox invocation payload")
  }
}

async function loadConfig(invocation: SandboxInvocation): Promise<SandboxRuntimeConfig> {
  let source: string
  try {
    source = await readFile(invocation.settingsPath, "utf8")
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read SRT settings at ${invocation.settingsPath}: ${detail}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid JSON in SRT settings at ${invocation.settingsPath}: ${detail}`)
  }

  const resolved = resolveFilesystemPaths(parsed, invocation.projectRoot, invocation.settingsPath)
  return SandboxRuntimeConfigSchema.parse(resolved)
}

export function resolveFilesystemPaths(value: unknown, projectRoot: string, settingsPath: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const config = structuredClone(value) as Record<string, unknown>
  const filesystem = config.filesystem
  if (!filesystem || typeof filesystem !== "object" || Array.isArray(filesystem)) return config
  const rules = filesystem as Record<string, unknown>
  for (const key of ["denyRead", "allowRead", "allowWrite", "denyWrite"]) {
    if (Array.isArray(rules[key])) rules[key] = rules[key].map((entry) => resolvePathEntry(entry, projectRoot))
  }
  // A project-local settings file must not be writable by the command it
  // governs, even if the template grants writes to the project root.
  const denyWrite = Array.isArray(rules.denyWrite) ? rules.denyWrite : []
  rules.denyWrite = [...denyWrite, { path: settingsPath, literal: true }]
  return config
}

function resolvePathEntry(value: unknown, projectRoot: string): FilesystemPathEntry {
  if (typeof value === "string") return resolveEntry(value, projectRoot)
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { literal?: unknown }).literal === true &&
    typeof (value as { path?: unknown }).path === "string"
  )
    return { path: resolveEntry((value as { path: string }).path, projectRoot), literal: true }
  return value as FilesystemPathEntry
}

function resolveEntry(entry: string, projectRoot: string): string {
  if (entry === "~" || entry.startsWith("~/")) return entry
  return isAbsolute(entry) ? entry : resolve(projectRoot, entry)
}

export function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function runCommand(command: string, cwd: string): Promise<number> {
  // Bubblewrap may use PWD to restore its cwd after setting up the sandbox.
  // An inherited logical path can be hidden even when the physical cwd is allowed.
  const physicalCwd = await realpath(cwd)
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, { shell: true, cwd, env: { ...process.env, PWD: physicalCwd }, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => resolveRun(code ?? (signal ? 128 : 1)))
  })
}

function reportFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`opencode-srt: ${message}\n`)
  process.exit(125)
}
