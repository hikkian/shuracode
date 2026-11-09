---
description: Show memories with source/date/trust; export [file], import <file>, stats, restore <key>
---
$ARGUMENTS

Without arguments, or with words to search for: list the matching memories (memory_search; the empty query lists
everything by type), one line each with the passport the tool prints: (kind, who said it, when, how sure). Point
out memories that look outdated, duplicated or contradictory (memory_search marks contradictions with "!"), and
offer to fix them with /fix. Do not change anything without my confirmation.

When the gateway management tools are available, use them instead of the shell:
- `export [file]`: memory_export returns JSON Lines including passports and journal. Show the returned text, or write it to the requested file outside the protected data directory.
- `import <file>`: the user-command hook imports the named file with the user's authority; report its counts and do not call `memory_import_records` again. MCP imports are always external proposed quotes, even if the file has Shura export markers. Importing a Shura export with its confirmed passports is available only on this user command path.
- `stats`: memory_stats reports counts and disk statistics.
- `restore <key>`: the user-command hook restores the named record; report the result without calling `memory_restore` again. The model tool cannot restore records.
Never write the database or MEMORY.md directly.

Without the gateway management tools, subcommands run the store's command line in the terminal (`shura memory ...` from the Shura checkout; the same
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
