// QLSP1: the stand-in language server speaks the protocol the engine uses (Content-Length frames, initialize, didOpen/didChange,
// publishDiagnostics, shutdown, exit), and reports an error only where the marker is.
import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { diagnosticsFor } from "./lsp/stub-lsp.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, "lsp", "stub-lsp.mjs")

function frame(message) {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

// Reads the messages the server writes until `count` of them have arrived or the timeout ends.
function collect(child, count, timeoutMs = 3000) {
  const messages = []
  let buffer = ""
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`got ${messages.length} of ${count} messages`)), timeoutMs)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      for (;;) {
        const head = buffer.indexOf("\r\n\r\n")
        if (head === -1) break
        const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.slice(0, head))[1])
        const bytes = Buffer.from(buffer.slice(head + 4), "utf8")
        if (bytes.length < length) break
        const body = bytes.subarray(0, length).toString("utf8")
        buffer = bytes.subarray(length).toString("utf8")
        messages.push(JSON.parse(body))
        if (messages.length === count) {
          clearTimeout(timer)
          resolve(messages)
          return
        }
      }
    })
  })
}

test("the marker line is the only diagnostic, with its position", () => {
  const text = "a = 1\nb = <<<ERR>>> 2\nc = 3\n<<<ERR>>>\n"
  const diags = diagnosticsFor(text)
  assert.equal(diags.length, 2)
  assert.equal(diags[0].range.start.line, 1)
  assert.equal(diags[0].severity, 1)
  assert.equal(diags[1].range.start.line, 3)
  assert.deepEqual(diagnosticsFor("clean\nfile\n"), [])
})

test("the server answers initialize and reports diagnostics for an opened file", async () => {
  const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "inherit"] })
  const replies = collect(child, 2)
  child.stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
  child.stdin.write(frame({ jsonrpc: "2.0", method: "initialized", params: {} }))
  child.stdin.write(frame({
    jsonrpc: "2.0", method: "textDocument/didOpen",
    params: { textDocument: { uri: "file:///tmp/x.py", languageId: "python", version: 1, text: "ok = 1\nbad = <<<ERR>>>\n" } },
  }))
  const [init, diag] = await replies
  assert.equal(init.id, 1)
  assert.equal(init.result.capabilities.textDocumentSync, 1)
  assert.equal(diag.method, "textDocument/publishDiagnostics")
  assert.equal(diag.params.uri, "file:///tmp/x.py")
  assert.equal(diag.params.diagnostics.length, 1)
  child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "shutdown" }))
  child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }))
  await new Promise((resolve) => child.on("exit", resolve))
  assert.equal(child.exitCode, 0)
})

test("a change that removes the marker clears the diagnostics", async () => {
  const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "inherit"] })
  const replies = collect(child, 2)
  child.stdin.write(frame({
    jsonrpc: "2.0", method: "textDocument/didOpen",
    params: { textDocument: { uri: "file:///tmp/y.ts", languageId: "typescript", version: 1, text: "let a = <<<ERR>>>\n" } },
  }))
  child.stdin.write(frame({
    jsonrpc: "2.0", method: "textDocument/didChange",
    params: { textDocument: { uri: "file:///tmp/y.ts", version: 2 }, contentChanges: [{ text: "let a = 1\n" }] },
  }))
  const [first, second] = await replies
  assert.equal(first.params.diagnostics.length, 1)
  assert.equal(second.params.diagnostics.length, 0)
  child.kill()
})
