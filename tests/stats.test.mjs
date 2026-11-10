// Tests for plugin/stats.tsx: the numbers behind /stats, the status line and the side panel.
// Run: node --test tests/stats.test.mjs   (needs Node 23.5+ for registerHooks and stripTypeScriptTypes)
// The logic file has no JSX and no imports, so a small hook strips the types from the .tsx file and Node can load it.
// Every gateway here is a fake HTTP server on 127.0.0.1 with an ephemeral port. No model, no GPU, no real gateway.
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { registerHooks, stripTypeScriptTypes } from "node:module"

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const stats = await import("../plugin/stats.tsx")

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A fake gateway. `respond(req, res, n)` answers the n-th request; `hits` records every request path.
function fakeGateway(respond) {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url)
    respond(req, res, hits.length)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/monitor/api/state`,
        hits,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

const sendJson = (value) => (req, res) => {
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(value))
}

const healthy = {
  schema: 1,
  capabilities: {
    gpu_nvidia: true, gpu_amd: false, gpu_intel: false, system_linux: true, zram: true, psi: true,
    cpu_temp: true, nvme: false, slots: true, timings: true, expert_cache: false,
  },
  health: { level: "ok", reasons: [], hint: "No action needed." },
  header: { model: "tiel-coder", mode: "AUTO", state: "LOADED", state_color: "ok", model_uptime_seconds: 812 },
  last_request: { decode_per_second: 51.4 },
  context: { used_tokens: 24000, limit_tokens: 200000, used_percent: 12 },
  gpu: { total_mib: 16000, used_mib: 13000, free_mib: 3000, temperature_c: 61 },
  memory: { ram_total_mib: 32768, ram_available_mib: 16384, ram_used_mib: 16384, zram_used_percent: 20 },
  cpu: { temperature_c: 55 },
}
const withHealth = (level, hint) => ({ ...healthy, health: { level, reasons: [], hint } })

const reading = (state) => stats.parseReading(true, JSON.stringify(state))

// ------------------------------------------------------------------------------------------ pure functions

test("toneOf maps the gateway's health levels to colours and anything else to grey", () => {
  assert.equal(stats.toneOf("ok"), "green")
  assert.equal(stats.toneOf("warn"), "amber")
  assert.equal(stats.toneOf("crit"), "red")
  assert.equal(stats.toneOf(undefined), "grey")
  assert.equal(stats.toneOf("bogus"), "grey")
})

test("monitorUrl takes the origin of the gateway option, so the page path is not kept", () => {
  assert.equal(stats.monitorUrl("http://127.0.0.1:8080/guardian/status"), "http://127.0.0.1:8080/monitor/api/state")
  assert.equal(stats.monitorUrl("not a url"), "")
})

test("monitorPageUrl opens the gateway's /monitor page, compact only on request", () => {
  assert.equal(stats.monitorPageUrl("http://127.0.0.1:8080/guardian/status", false), "http://127.0.0.1:8080/monitor")
  assert.equal(stats.monitorPageUrl("http://127.0.0.1:8080/guardian/status", true), "http://127.0.0.1:8080/monitor?view=compact")
  assert.equal(stats.monitorPageUrl("http://10.0.0.5:9000/x/y?z=1", false), "http://10.0.0.5:9000/monitor")
  assert.equal(stats.monitorPageUrl("not a url", true), "")
})

test("openInBrowser runs xdg-open detached without waiting, and reports an opener that cannot start", () => {
  const calls = []
  let unrefs = 0
  const okSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { on() { return this }, unref() { unrefs += 1 } }
  }
  let failed = 0
  stats.openInBrowser("http://127.0.0.1:8080/monitor", okSpawn, () => { failed += 1 })
  assert.deepEqual(calls, [{ cmd: "xdg-open", args: ["http://127.0.0.1:8080/monitor"], opts: { detached: true, stdio: "ignore" } }])
  assert.equal(unrefs, 1)
  assert.equal(failed, 0)

  // the opener is missing: the child reports ENOENT on its "error" event
  let handler = null
  const missingSpawn = () => ({ on(ev, fn) { if (ev === "error") handler = fn; return this }, unref() {} })
  stats.openInBrowser("http://127.0.0.1:8080/monitor", missingSpawn, () => { failed += 1 })
  handler(new Error("spawn xdg-open ENOENT"))
  assert.equal(failed, 1)

  // spawn itself throws synchronously
  stats.openInBrowser("http://127.0.0.1:8080/monitor", () => { throw new Error("EACCES") }, () => { failed += 1 })
  assert.equal(failed, 2)
})

test("the stats commands no longer call the missing `shura monitor` subcommand", () => {
  const src = readFileSync(new URL("../plugin/shuracode.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(src, /spawn\("shura"/)
  assert.match(src, /openInBrowser\(url, spawn,/)
})

test("num shows n/a for anything that is not a finite number, never 0", () => {
  assert.equal(stats.num(51.44, 1, " tok/s"), "51.4 tok/s")
  for (const missing of [null, undefined, NaN, Infinity, "12", {}]) {
    assert.equal(stats.num(missing, 0, "%"), "n/a", String(missing))
  }
})

test("ratio and bar: a missing number gives no bar, and values are clipped to 0..1", () => {
  assert.equal(stats.ratio(null, 10), null)
  assert.equal(stats.ratio(5, 0), null)
  assert.equal(stats.ratio(5, 10), 0.5)
  assert.equal(stats.ratio(20, 10), 1)
  assert.equal(stats.ratio(-3, 10), 0)
  assert.equal(stats.bar(null), null)
  assert.equal(stats.bar(0.5, 10), "█████░░░░░")
  assert.equal(stats.bar(0, 4), "░░░░")
  assert.equal(stats.bar(1, 4), "████")
})

test("parseReading: a broken, empty, failed or odd reply is offline or unsupported, never a throw", () => {
  assert.equal(stats.parseReading(true, JSON.stringify(healthy)).kind, "ok")
  assert.equal(stats.parseReading(false, "{}").kind, "offline") // HTTP 500
  assert.equal(stats.parseReading(true, "{").kind, "offline") // broken JSON
  assert.equal(stats.parseReading(true, "").kind, "offline") // empty body
  assert.equal(stats.parseReading(true, "[]").kind, "offline") // an array, not an object
  assert.equal(stats.parseReading(true, "42").kind, "offline") // a number
  assert.equal(stats.parseReading(true, JSON.stringify({ ...healthy, schema: 2 })).kind, "unsupported") // newer schema
  assert.equal(stats.parseReading(true, "{}").kind, "unsupported") // no schema at all
})

test("viewOf: the status colour is the gateway's own level, and only red shows a banner", () => {
  const green = stats.viewOf(reading(healthy))
  assert.equal(green.tone, "green")
  assert.equal(green.banner, null)
  assert.match(green.line, /^tiel-coder · 51\.4 tok\/s · ctx 12% · VRAM free 2\.9 of 15\.6 GB$/)

  const amber = stats.viewOf(reading(withHealth("warn", "Free memory is low")))
  assert.equal(amber.tone, "amber")
  assert.equal(amber.banner, null)

  const red = stats.viewOf(reading(withHealth("crit", "GPU memory or temperature is critical")))
  assert.equal(red.tone, "red")
  assert.equal(red.banner, "GPU memory or temperature is critical")
})

test("viewOf: rows come in a fixed order, and each row with a number has a bar", () => {
  const { rows } = stats.viewOf(reading(healthy))
  assert.deepEqual(rows.map((r) => r.label), ["Speed", "Context", "VRAM", "RAM", "zram", "GPU temp", "CPU temp"])
  for (const row of rows) assert.ok(row.bar, `${row.label} has no bar`)
  assert.equal(rows.find((r) => r.label === "RAM").bar, "██████████░░░░░░░░░░") // half used
})

test("viewOf: a capability the gateway reports false, or a missing number, shows n/a and no bar", () => {
  const state = {
    ...healthy,
    capabilities: { ...healthy.capabilities, gpu_nvidia: false, zram: false, cpu_temp: false },
    last_request: { decode_per_second: null },
  }
  const { rows } = stats.viewOf(reading(state))
  for (const label of ["Speed", "VRAM", "zram", "GPU temp", "CPU temp"]) {
    const row = rows.find((r) => r.label === label)
    assert.equal(row.text, "n/a", label)
    assert.equal(row.bar, null, label)
  }
  assert.equal(rows.find((r) => r.label === "Context").text, "12%") // still reported, still shown
  for (const row of rows) {
    if (row.text === "n/a") assert.equal(row.bar, null, row.label)
  }
})

test("viewOf: no reply yet, offline and unsupported read as grey words with no rows", () => {
  const waiting = stats.viewOf(null)
  assert.deepEqual([waiting.tone, waiting.line, waiting.rows.length], ["grey", "…", 0])
  const offline = stats.viewOf({ kind: "offline", reason: "unreachable" })
  assert.deepEqual([offline.tone, offline.line, offline.banner], ["grey", "Offline", null])
  const unsupported = stats.viewOf({ kind: "unsupported", reason: "schema 9" })
  assert.deepEqual([unsupported.tone, unsupported.line], ["grey", "n/a"])
})

// ------------------------------------------------------------------------------------------ poller, fake gateway

test("with a panel open the gateway is read once per second: a first fetch at once, then about one a second", async (t) => {
  const gw = await fakeGateway(sendJson(healthy))
  t.after(() => gw.close())
  const poller = stats.createPoller({ url: gw.url })
  poller.retain()
  await wait(3200)
  poller.release()
  assert.ok(gw.hits.length >= 3 && gw.hits.length <= 5, `requests in 3.2 s: ${gw.hits.length}`)
  assert.equal(stats.viewOf(poller.latest()).tone, "green")
})

test("with the panel closed, requests stop: none after the first fetch, over 5 seconds", async (t) => {
  const gw = await fakeGateway(sendJson(healthy))
  t.after(() => gw.close())
  const poller = stats.createPoller({ url: gw.url })
  poller.retain()
  await wait(300)
  poller.release()
  const atClose = gw.hits.length
  assert.equal(atClose, 1, "the first fetch happens at once")
  await wait(5000)
  assert.equal(gw.hits.length - atClose, 0, "requests made in 5 s with the panel closed")
})

test("two consumers share one poller: requests continue until the last one releases", async (t) => {
  const gw = await fakeGateway(sendJson(healthy))
  t.after(() => gw.close())
  const poller = stats.createPoller({ url: gw.url, pollMs: 100 })
  poller.retain()
  poller.retain()
  await wait(350)
  poller.release()
  const afterFirstRelease = gw.hits.length
  await wait(350)
  assert.ok(gw.hits.length > afterFirstRelease, "polling stopped while one consumer was still there")
  poller.release()
  const afterLast = gw.hits.length
  await wait(350)
  assert.equal(gw.hits.length, afterLast)
})

test("a slow gateway (no reply for 10 s) is offline after the timeout, and no request overlaps it", async (t) => {
  const gw = await fakeGateway((req, res) => {
    const timer = setTimeout(() => res.end("{}"), 10000)
    res.on("close", () => clearTimeout(timer))
  })
  t.after(() => gw.close())
  const poller = stats.createPoller({ url: gw.url })
  poller.retain()
  await wait(2500)
  assert.equal(gw.hits.length, 1, "a second request started while the first was still waiting")
  await wait(1000)
  poller.release()
  assert.equal(poller.latest().kind, "offline")
  assert.equal(stats.viewOf(poller.latest()).line, "Offline")
})

test("broken JSON, an HTTP 500, an empty body and a newer schema each read as offline or n/a, never a throw", async (t) => {
  const cases = [
    ["broken JSON", (req, res) => res.end("{"), "offline"],
    ["HTTP 500", (req, res) => { res.statusCode = 500; res.end("boom") }, "offline"],
    ["empty body", (req, res) => res.end(""), "offline"],
    ["newer schema", sendJson({ ...healthy, schema: 2 }), "unsupported"],
  ]
  for (const [name, respond, kind] of cases) {
    const gw = await fakeGateway(respond)
    const poller = stats.createPoller({ url: gw.url })
    poller.retain()
    await wait(200)
    poller.release()
    await gw.close()
    assert.equal(poller.latest()?.kind, kind, name)
    assert.ok(stats.viewOf(poller.latest()).line.length > 0, name)
  }
})

test("a fetch that throws and a consumer that throws do not stop the poller", async () => {
  let calls = 0
  const poller = stats.createPoller({
    url: "http://127.0.0.1:9/monitor/api/state",
    pollMs: 100,
    fetch: async () => {
      calls += 1
      throw new Error("boom")
    },
    onChange: () => {
      throw new Error("consumer broke")
    },
  })
  poller.retain()
  await wait(350)
  poller.release()
  assert.ok(calls >= 3, `only ${calls} fetches`)
  assert.equal(poller.latest().kind, "offline")
})

test("no gateway URL: the poller makes no request and reads offline", async () => {
  const poller = stats.createPoller({ url: "" })
  poller.retain()
  poller.release()
  assert.equal(poller.latest().kind, "offline")
  assert.equal(poller.latest().reason, "no gateway")
})

test("stop() ends polling at once, even with consumers still retained", async (t) => {
  const gw = await fakeGateway(sendJson(healthy))
  t.after(() => gw.close())
  const poller = stats.createPoller({ url: gw.url, pollMs: 100 })
  poller.retain()
  await wait(250)
  poller.stop()
  const atStop = gw.hits.length
  await wait(350)
  assert.equal(gw.hits.length, atStop)
})

test("the banner follows the gateway through red and back, and goes when the state recovers", async (t) => {
  let current = healthy
  const gw = await fakeGateway((req, res) => sendJson(current)(req, res))
  t.after(() => gw.close())
  const seen = []
  const poller = stats.createPoller({
    url: gw.url,
    pollMs: 100,
    onChange: (r) => seen.push(stats.viewOf(r)),
  })
  poller.retain()
  await wait(250)
  current = withHealth("crit", "GPU memory or temperature is critical")
  await wait(350)
  current = healthy
  await wait(350)
  poller.release()
  const reds = seen.filter((v) => v.tone === "red")
  assert.ok(reds.length >= 1, "no red reading seen")
  assert.ok(reds.every((v) => v.banner === "GPU memory or temperature is critical"))
  assert.equal(seen.at(-1).tone, "green")
  assert.equal(seen.at(-1).banner, null)
})
