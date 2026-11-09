---
description: Remove something from Shura's memory
---
Remove this from your permanent memory: $ARGUMENTS

If the arguments include `--purge`, the user-command hook has already performed the exported permanent deletion; report completion and do not call a memory tool. Otherwise find the matching memory in the memory index (use memory_search if unsure). If exactly one matches, delete
it with memory_delete. If several could match, list them and ask which one. If a memory is only partly
wrong, update it with memory_save instead of deleting it. Tell me in one line what changed.

memory_delete is a soft deletion: the record leaves the index and the search but stays in the store, and
`/memory restore <name>` brings it back. With `--purge` the record is removed for good: run
`shura memory forget <name> --purge` in the terminal (the store first appends the record to purged.jsonl next
to the database and prints that path) and tell me where that file is.

The memory tool only supports soft deletion. Never ask the model tool to purge; `--purge` is a user-only terminal command.
