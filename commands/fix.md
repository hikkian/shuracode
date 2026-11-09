---
description: Correct something Shura remembers (keeps the old version in history)
---
For `/fix <key> -> <correction>`, the user-command hook has already applied the version change. Read the key back and report its new passport; do not call `memory_fix` a second time. For other correction syntax, use the proposal behavior below. `$ARGUMENTS`

If memory_fix is available, find the exact key with memory_search, then call memory_fix with name, corrected content, and relation (replace, dispute or both_true). Show the returned passport. Otherwise use the existing path below.

Find the memory it is about in the memory index (memory_search if unsure). Save the corrected text with memory_save
under the same name: when the text differs, the store keeps the old text as a superseded version with its passport,
so nothing is lost. If the correction says both versions are true in different situations, or disagrees with a
confirmed memory, do not overwrite it: tell me both texts in one line each and ask which holds; the person can then
record the dispute with `shura memory fix <name> --body "..." --relation dispute` (or both_true), and memory_search
shows the open contradiction with "!" until it is resolved. Never store passwords, tokens or personal data. Then tell
me in one line what changed.
