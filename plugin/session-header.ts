// The X-Shura-Session header for the gateway's session cache (SESS2b). It is a uuid derived from the engine's session id:
// stable for the session, unique per session, and it reveals nothing about the project, the paths or the user.
import { createHash } from "node:crypto"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function sessionHeader(engineSessionId: string): string {
  const hex = createHash("sha256").update(`shuracode-session:${engineSessionId}`).digest("hex")
  // shape a uuid (version 4, RFC 4122 variant) from the digest
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  return UUID_RE.test(uuid) ? uuid : ""
}
