// Lifelong transport and display. The client never opens the memory database.
export type MemorySummary = { records: number; rules: number; version: number }
export function statusText(s?: MemorySummary): string {
  return s ? `memory: ${s.records} records, rules: ${s.rules}, version ${s.version}` : "memory: unavailable"
}
export function gatewayOrigin(value: string): string {
  const u = new URL(value)
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.username || u.password) throw new Error("Expected loopback gateway")
  return u.origin
}
export async function gatewayCall(origin: string, op: string, data?: unknown, model?: string, confirmationToken?: string): Promise<any> {
  const url = gatewayOrigin(origin) + "/guardian/memory/" + op + (model ? `?model=${encodeURIComponent(model)}` : "")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (process.env.SHURA_GATEWAY_API_KEY) headers.Authorization = `Bearer ${process.env.SHURA_GATEWAY_API_KEY}`
  if (confirmationToken) headers["X-Shura-Confirmation"] = confirmationToken
  const res = await fetch(url, { method: data === undefined ? "GET" : "POST", headers, redirect: "error",
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`memory/${op}: HTTP ${res.status}`)
  return res.json()
}
