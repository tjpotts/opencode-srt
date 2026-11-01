The `shell` tool runs all commands inside a `sandbox-runtime` sandbox with user-defined limits on filesystem and network access. Use it by default.

When the sandboxed `shell` tool fails because of a sandbox restriction, and the command is necessary for the requested task, use `unsafe_shell` with a specific justification. Do not work around the restriction using other tools or manually reconstruct results.

On Linux, certain protected dotfiles, such as `.bashrc`, `.gitconfig`, and `.mcp.json`, may appear as empty, read-only files when they do not exist in the project directory. These are sandbox protection artifacts, not evidence that the project contains those files. Do not attempt to remove or overwrite them.

Shell commands additionally run inside the sandbox. Other tools, including OpenCode file tools and MCP tools, use OpenCode's built-in permissions system.
