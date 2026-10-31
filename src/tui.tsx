import { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"

const BYPASS_PERMISSION = "unsafe_shell"

type BypassMetadata = {
  command?: unknown
  cwd?: unknown
}

function bypassDetails(metadata: unknown): { command?: string; cwd?: string } {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {}
  const value = metadata as BypassMetadata
  return {
    ...(typeof value.command === "string" ? { command: value.command } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
  }
}

export default Plugin.define({
  id: "srt.tui",
  setup(ctx) {
    return ctx.ui.slot({
      append: "session.composer.top",
      render: ({ sessionID }) => {
        const request = createMemo(() =>
          (ctx.data.session.permission.list(sessionID) ?? []).find((item) => item.action === BYPASS_PERMISSION),
        )
        const details = createMemo(() => bypassDetails(request()?.metadata))

        return (
          <Show when={request()}>
            <box border={["left"]} borderColor={ctx.theme.text.feedback.warning.base} paddingLeft={2} paddingTop={1} paddingBottom={1}>
              <box flexDirection="column" gap={1}>
                <text fg={ctx.theme.text.feedback.warning.base}>unsafe_shell</text>
                <text fg={ctx.theme.text.base}>This command will be run outside the SRT sandbox.</text>
                <Show when={details().command}>
                  {(command) => <text fg={ctx.theme.text.base}>$ {command()}</text>}
                </Show>
                <Show when={details().cwd}>
                  {(cwd) => <text fg={ctx.theme.text.muted}>Working directory: {cwd()}</text>}
                </Show>
              </box>
            </box>
          </Show>
        )
      },
    })
  },
})
