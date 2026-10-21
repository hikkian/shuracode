#!/usr/bin/env node
// QLSP1: a stand-in language server for tests (stdio, JSON-RPC with Content-Length framing). It reports one error for every line that
// contains the marker <<<ERR>>> and nothing else. It is NOT pyright or typescript-language-server (neither is installed here, and
// their download needs the user's word): it only proves that the engine's LSP plumbing runs, with a known answer and a known delay.
import process from "node:process"

const MARKER = "<<<ERR>>>"
const DELAY_MS = Number(process.env.STUB_LSP_DELAY_MS ?? 0)
let buffer = Buffer.alloc(0)

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

export function diagnosticsFor(text) {
  const out = []
  text.split("\n").forEach((line, index) => {
    const at = line.indexOf(MARKER)
    if (at === -1) return
    out.push({
      range: { start: { line: index, character: at }, end: { line: index, character: at + MARKER.length } },
      severity: 1,
      source: "stub-lsp",
      message: "stub: error marker found on this line",
    })
  })
  return out
}

function publish(uri, text) {
  const diagnostics = diagnosticsFor(text)
  setTimeout(() => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } }), DELAY_MS)
}

function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1 } } })
  } else if (message.method === "textDocument/didOpen") {
    publish(message.params.textDocument.uri, message.params.textDocument.text)
  } else if (message.method === "textDocument/didChange") {
    publish(message.params.textDocument.uri, message.params.contentChanges.at(-1).text)
  } else if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null })
  } else if (message.method === "exit") {
    process.exit(0)
  }
}

function pump() {
  for (;;) {
    const head = buffer.indexOf("\r\n\r\n")
    if (head === -1) return
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, head).toString("ascii"))?.[1])
    if (!Number.isFinite(length)) {
      buffer = buffer.subarray(head + 4)
      continue
    }
    if (buffer.length < head + 4 + length) return
    const body = buffer.subarray(head + 4, head + 4 + length).toString("utf8")
    buffer = buffer.subarray(head + 4 + length)
    handle(JSON.parse(body))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    pump()
  })
  process.stdin.on("end", () => process.exit(0))
}
