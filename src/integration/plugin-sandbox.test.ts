import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { delimiter, join } from "node:path"
import test from "node:test"
import plugin from "../index.js"

type ShellCreateEvent = {
  command: string
  cwd: string
  shell: string
  timeout: number
  env: Record<string, string | undefined>
}

type ShellHook = (event: ShellCreateEvent) => Promise<void> | void

type CommandResult = {
  code: number | null
  stderr: string
  stdout: string
}

const hasBubblewrap = (process.env.PATH ?? "").split(delimiter).some((directory) => existsSync(join(directory, "bwrap")))

const nativeSandboxUnavailable = process.platform !== "linux" || !hasBubblewrap || !(await canCreateUnixSocket())

async function canCreateUnixSocket(): Promise<boolean> {
  const path = join(process.cwd(), `.opencode-srt-socket-${process.pid}.sock`)
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(path, resolve)
    })
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(path, { force: true })
    return true
  } catch {
    if (server.listening) server.close()
    await rm(path, { force: true })
    return false
  }
}

async function withProject(
  policy: object,
  run: (project: { root: string; settingsPath: string; invoke: (command: string, cwd?: string) => Promise<CommandResult> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), ".opencode-srt-integration-"))
  const settingsPath = join(root, ".opencode", "srt-settings.json")
  let hook: ShellHook | undefined

  try {
    await mkdir(join(root, ".opencode"), { recursive: true })
    await writeFile(settingsPath, JSON.stringify(policy))
    await plugin.setup({
      location: { directory: root, project: { directory: root } },
      options: { settingsPath, nodePath: process.execPath },
      permission: {
        async hook() {
          return { async dispose() {} }
        },
      },
      session: {
        async hook() {
          return { async dispose() {} }
        },
      },
      shell: {
        async hook(name: string, callback: ShellHook) {
          assert.equal(name, "create.before")
          hook = callback
          return { async dispose() {} }
        },
      },
      tool: {
        async transform(callback: (editor: { get(id: string): unknown; add(tool: unknown): void }) => void) {
          callback({
            get(id) {
              if (id !== "shell") return undefined
              return { input: { type: "object" }, async execute() { return { content: "" } } }
            },
            add() {},
          })
          return { async dispose() {} }
        },
      },
    } as never)

    assert.ok(hook, "plugin should register OpenCode's shell creation hook")
    const activeHook = hook
    await run({
      root,
      settingsPath,
      async invoke(command, cwd = root) {
        const event: ShellCreateEvent = {
          command,
          cwd,
          shell: "/bin/sh",
          timeout: 30_000,
          // SRT creates proxy sockets under TMPDIR. Use the writable fixture
          // rather than inheriting a host-specific (or read-only) temp path.
          env: { ...process.env, TMPDIR: root },
        }
        await activeHook(event)
        assert.match(event.shell, /\/runtime\/bin\/sh$/)
        assert.ok(event.env.OPENCODE_SRT_PAYLOAD)
        assert.equal(event.env.OPENCODE_SRT_NODE, process.execPath)
        return runCommand(event.shell, ["-c", event.command], event.cwd, event.env)
      },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function runCommand(command: string, args: string[], cwd: string, env: Record<string, string | undefined>): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout, stderr }))
  })
}

test("runs OpenCode shell commands inside SRT with project-root filesystem rules", { skip: nativeSandboxUnavailable }, async () => {
  await withProject(
    {
      filesystem: { denyRead: [], allowRead: [], allowWrite: ["output"], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [] },
    },
    async ({ root, invoke }) => {
      await mkdir(join(root, "nested"))
      await mkdir(join(root, "output"))

      const result = await invoke("printf sandboxed > ../output/result.txt", join(root, "nested"))

      assert.equal(result.code, 0, result.stderr)
      assert.equal(await readFile(join(root, "output", "result.txt"), "utf8"), "sandboxed")
    },
  )
})

test("blocks writes denied by the SRT policy", { skip: nativeSandboxUnavailable }, async () => {
  await withProject(
    {
      filesystem: { denyRead: [], allowRead: [], allowWrite: ["."], denyWrite: ["blocked.txt"] },
      network: { allowedDomains: [], deniedDomains: [] },
    },
    async ({ root, invoke }) => {
      const blocked = join(root, "blocked.txt")
      await writeFile(blocked, "original")

      const result = await invoke("printf changed > blocked.txt")

      assert.notEqual(result.code, 0)
      assert.equal(await readFile(blocked, "utf8"), "original")
    },
  )
})

test("protects the selected SRT settings file even when the project is writable", { skip: nativeSandboxUnavailable }, async () => {
  await withProject(
    {
      filesystem: { denyRead: [], allowRead: [], allowWrite: ["."], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [] },
    },
    async ({ settingsPath, invoke }) => {
      const original = await readFile(settingsPath, "utf8")

      const result = await invoke("printf changed > .opencode/srt-settings.json")

      assert.notEqual(result.code, 0)
      assert.equal(await readFile(settingsPath, "utf8"), original)
    },
  )
})

test("fails closed when the selected SRT policy is missing", { skip: process.platform !== "linux" }, async () => {
  await withProject(
    {
      filesystem: { denyRead: [], allowRead: [], allowWrite: ["."], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [] },
    },
    async ({ root, settingsPath, invoke }) => {
      await rm(settingsPath)

      const result = await invoke("printf escaped > escaped.txt")

      assert.equal(result.code, 125)
      assert.match(result.stderr, /cannot read SRT settings/)
      await assert.rejects(access(join(root, "escaped.txt")))
    },
  )
})
