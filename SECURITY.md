# Security

ShuraCode runs a coding agent that can read files and run commands on your machine.

- **Permissions** are in `config/shuracode.json.in`. In Build mode, unknown shell commands ask first and
  destructive ones (`rm -rf`, `mkfs`, `reboot`, ...) are denied. Plan mode cannot edit files, and any
  command with a redirect or `tee` asks first.
- **Memory** lives in `~/.local/share/shuracode/memory` (folder `0700`, files `0600`). The memory server
  refuses content that looks like credentials, but it is a guard rail, not a secret scanner: do not ask the
  agent to remember secrets.
- **Network**: update checks, sharing, model catalogue downloads and bundled cloud plugins are disabled. The
  model endpoint defaults to the local Shura gateway on 127.0.0.1.

Report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository.
