---
description: Save something to Shura's permanent memory
---
The ShuraCode user-command hook has already performed explicit `/remember <text>` saves and `/remember confirm <key>` confirmations. Read the key back with memory_search and report its passport; do not repeat the write. `$ARGUMENTS`

If nothing was given after /remember, save the most useful non-obvious thing learned in this conversation
(a preference, a correction, or project knowledge that is not in the code). Check the memory index first:
if a memory on the same topic exists, update it under the same name instead of adding a new one. Pick the
type carefully, keep it to one fact, and never store passwords, tokens or personal data. Then tell me in
one line what you saved.
