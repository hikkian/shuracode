---
description: Show what Shura remembers, or export/import/stats/restore the memory
---
$ARGUMENTS

Without arguments, or with words to search for: list the matching memories (memory_search; the empty query lists
everything by type), one line each with the passport the tool prints: (kind, who said it, when, how sure). Point
out memories that look outdated, duplicated or contradictory (memory_search marks contradictions with "!"), and
offer to fix them with /fix. Do not change anything without my confirmation.

Subcommands run the store's command line in the terminal (`shura memory ...` from the Shura checkout; the same
file is `gateway/lifelong_store.py`, so `python3 <shura>/gateway/lifelong_store.py ...` is the same thing) and
report the result in one line:

- `export [file]`: `shura memory export [file]` writes JSON Lines with every passport plus a Markdown twin next to it.
- `import <file>`: `shura memory import <file>`; our own export comes back with its passports, any other text is
  stored as quotes with trust "proposed" and source "external", never as rules (`--external <name>` marks it so).
- `stats`: `shura memory stats`; records by kind, soft-deleted, open contradictions, file size and bytes written to
  disk since the process started.
- `restore <name>`: `shura memory restore <name>` brings back a soft-deleted memory.

Memories live in the store, not in the .md files any more: editing or deleting a file under the memory folder does
not change what Shura remembers; use these commands instead.
