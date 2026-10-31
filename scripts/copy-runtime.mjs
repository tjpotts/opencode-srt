import { chmod, cp, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { SUPPORTED_SHELL_NAMES } from "../dist/shells.js"

const destination = "dist/runtime/bin"

await mkdir(destination, { recursive: true })
await Promise.all(
  SUPPORTED_SHELL_NAMES.map(async (name) => {
    const target = join(destination, name)
    await cp("scripts/shell-wrapper", target)
    await chmod(target, 0o755)
  }),
)
