import assert from "node:assert/strict"
import test from "node:test"
import { parseInvocationPayload, quoteForShell, resolveFilesystemPaths } from "./helper.js"

test("quotes values safely for the shell command passed to SRT", () => {
  assert.equal(quoteForShell("echo 'hello'"), "'echo '\\''hello'\\'''")
})

test("rejects malformed sandbox invocation payloads", () => {
  assert.throws(() => parseInvocationPayload("not-base64"), /invalid sandbox invocation payload/)
})

test("anchors relative filesystem rules at the project root and protects settings", () => {
  const policy = {
    filesystem: {
      allowRead: [".", "~/keep"],
      allowWrite: ["output"],
      denyWrite: [{ path: ".env", literal: true }],
    },
  }

  const resolved = resolveFilesystemPaths(policy, "/workspace/project", "/workspace/project/.opencode/srt.json")

  assert.deepEqual(resolved, {
    filesystem: {
      allowRead: ["/workspace/project", "~/keep"],
      allowWrite: ["/workspace/project/output"],
      denyWrite: [
        { path: "/workspace/project/.env", literal: true },
        { path: "/workspace/project/.opencode/srt.json", literal: true },
      ],
    },
  })
  assert.deepEqual(policy.filesystem.allowWrite, ["output"])
})
