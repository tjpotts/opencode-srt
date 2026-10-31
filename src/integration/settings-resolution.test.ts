import assert from "node:assert/strict"
import test from "node:test"
import { resolveDefaultSettingsPath } from "../index.js"

test("prefers SRT settings in the OpenCode config directory", () => {
  const opencodeSettings = "/home/test/.config/opencode/srt-settings.json"

  assert.equal(resolveDefaultSettingsPath("/home/test", (path) => path === opencodeSettings, "/home/test/.config"), opencodeSettings)
})

test("uses XDG_CONFIG_HOME for the OpenCode config directory", () => {
  const opencodeSettings = "/custom/config/opencode/srt-settings.json"

  assert.equal(resolveDefaultSettingsPath("/home/test", (path) => path === opencodeSettings, "/custom/config"), opencodeSettings)
})

test("falls back to legacy home-directory SRT settings", () => {
  assert.equal(resolveDefaultSettingsPath("/home/test", () => false, "/custom/config"), "/home/test/.srt-settings.json")
})
