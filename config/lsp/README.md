# LSP diagnostics after edits (QLSP1)

The engine (OpenCode 1.18.32) can show the model the language server's diagnostics for the file it has just edited: the `write` and
`edit` tool results then end with a `<diagnostics>` block. Off by default: the template has no `lsp` section, and the engine logs
"all LSPs are disabled".

## How to switch it on (not in the template yet)

- `"lsp": true` — the built-in servers (typescript-language-server for .ts/.js, pyright for .py). A server runs only when its binary
  is found. pyright has a download branch: set `OPENCODE_DISABLE_LSP_DOWNLOAD=1` in the environment, or the engine may try to fetch it.
- `"lsp": { "<id>": { "command": ["<binary>", "--stdio"], "extensions": [".py"], "env": {}, "initialization": {} } }` — a server
  of your own choice; `"disabled": true` turns one built-in off.

Neither binary is installed on this machine, and fetching them needs the user's word. `tests/lsp/stub-lsp.mjs` is a stand-in
(one error for each line with the marker `<<<ERR>>>`) used for the plumbing checks only.

## Measured (stand-in, not the real servers)

`reports/qlsp1/engine_check.py`: the same scripted model writes two files with an error each.
- with the stand-in: the diagnostic is in the tool result of both writes; cold start +3.1 to +3.9 s on the first edit (the server
  starts), warm +0.16 s on the second;
- without: no diagnostic, a write takes 0.01–0.12 s.

Real servers start slower than the stand-in, so the cold-start figure is a lower bound.
