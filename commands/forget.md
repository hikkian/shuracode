---
description: Remove something from Shura's memory
---
Remove this from your permanent memory: $ARGUMENTS

Find the matching memory in the memory index (use memory_search if unsure). If exactly one matches, delete
it with memory_delete. If several could match, list them and ask which one. If a memory is only partly
wrong, update it with memory_save instead of deleting it. Tell me in one line what changed.

memory_delete is a soft deletion: the record leaves the index and the search but stays in the store, and
`/memory restore <name>` brings it back. With `--purge` the record is removed for good: run
`shura memory forget <name> --purge` in the terminal (the store first appends the record to purged.jsonl next
to the database and prints that path) and tell me where that file is.
