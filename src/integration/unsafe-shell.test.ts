import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../index.js"

type ShellEvent = {
  command: string
  cwd: string
  shell: string
  timeout: number
  env: Record<string, string | undefined>
}

test("unsafe_shell requires bypass approval and delegates only its command outside SRT", async () => {
  if (process.platform !== "linux") return

  let shellHook: ((event: ShellEvent) => Promise<void> | void) | undefined
  let permissionHook: ((event: { action: string; effect: "allow" | "ask" | "deny"; message?: string }) => void) | undefined
  let permissionInput: unknown
  const tools = new Map<string, { input: object; execute(input: unknown, context: unknown): Promise<{ content: string }> }>()

  tools.set("shell", {
    input: { type: "object" },
    async execute(input) {
      const command = (input as { command: string }).command
      const event: ShellEvent = { command, cwd: "/project", shell: "/bin/sh", timeout: 1_000, env: {} }
      await shellHook?.(event)
      return { content: event.shell }
    },
  })

  await plugin.setup({
    location: { directory: "/project", project: { directory: "/project" } },
    options: { nodePath: process.execPath },
    permission: {
      async hook(_name: string, callback: typeof permissionHook) {
        permissionHook = callback
        return { async dispose() {} }
      },
      async assert(input: unknown) {
        permissionInput = input
      },
    },
    shell: {
      async hook(_name: string, callback: typeof shellHook) {
        shellHook = callback
        return { async dispose() {} }
      },
    },
    tool: {
      async transform(callback: (editor: { get(id: string): (typeof tools extends Map<string, infer T> ? T : never) | undefined; add(tool: { name: string } & (typeof tools extends Map<string, infer T> ? T : never)): void }) => void) {
        callback({ get: (id) => tools.get(id), add: (tool) => tools.set(tool.name, tool) })
        return { async dispose() {} }
      },
    },
  } as never)

  assert.ok(permissionHook)
  const permission = { action: "unsafe_shell", effect: "allow" as const }
  permissionHook(permission)
  assert.deepEqual(permission, { action: "unsafe_shell", effect: "ask", message: "This command will be run outside the SRT sandbox." })

  const context = { sessionID: "session", agent: "build", messageID: "message", id: "call" }
  const unsafe = tools.get("unsafe_shell")!
  assert.equal(
    await unsafe.execute({ command: "id", reason: "The sandbox blocks this required command." }, context).then((result) => result.content),
    "/bin/sh",
  )
  assert.deepEqual(permissionInput, {
    sessionID: "session",
    agent: "build",
    source: { type: "tool", messageID: "message", id: "call" },
    action: "unsafe_shell",
    resources: ["id"],
    save: [],
    metadata: {
      command: "id",
      cwd: "/project",
      reason: "The sandbox blocks this required command.",
      sandbox: "bypassed",
    },
  })

  await assert.rejects(() => unsafe.execute({ command: "id", reason: "  " }, context), /non-blank reason/)

  const ordinary = tools.get("shell")!
  assert.match(await ordinary.execute({ command: "id" }, context).then((result) => result.content), /\/runtime\/bin\/sh$/)
})
