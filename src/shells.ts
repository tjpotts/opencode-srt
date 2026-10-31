/**
 * Shell basenames that OpenCode recognizes when it analyzes command
 * permissions. The build creates one wrapper executable for each name.
 */
export const SUPPORTED_SHELL_NAMES = [
  "bash",
  "dash",
  "fish",
  "ksh",
  "nu",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
] as const

export const FALLBACK_SHELL_NAME = "sh"
