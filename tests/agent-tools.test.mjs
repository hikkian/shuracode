import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, access } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import agentTools, { framesText, modelHasVision, renderText, resolveOptions, resolveTarget } from "../plugin/agent-tools/agent-tools.ts"

// AGTOOLS1: the agent's eyes — `render` (Chromium screenshot + layout problems) and `frames` (video frames + ffprobe).
// The execute paths need the shura-qa Playwright and ffmpeg; they are skipped where those are missing.

const QA = path.join(os.homedir(), ".local", "share", "shura-qa")
const havePlaywright = await access(path.join(QA, "venv", "bin", "python")).then(() => true, () => false)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title><style>body{margin:0;font-family:sans-serif}
.card{width:360px;padding:24px;background:#f3f4f6}h1{font-size:28px;margin:0 0 8px}p{line-height:1.5}
button{background:#0b6;color:#fff;padding:8px 16px;border:0}</style></head><body><div class="card"><h1>Hello card</h1>
<p>Some text here to render.</p><button>Go</button></div></body></html>`

function fakeClient({ modalities, providerID = "local", modelID = "m" } = {}) {
  return {
    session: { messages: async () => ({ data: [{ info: { role: "user" } }, { info: { role: "assistant", providerID, modelID } }] }) },
    config: {
      get: async () => ({ data: { provider: { [providerID]: { models: { [modelID]: modalities ? { modalities } : {} } } } } }),
      providers: async () => ({ data: { providers: [] } }),
    },
  }
}

test("agent tools stay off unless a flag turns them on", async () => {
  assert.deepEqual(await agentTools.server({ client: fakeClient(), directory: "/tmp" }, {}), {})
  assert.deepEqual(await agentTools.server({ client: fakeClient(), directory: "/tmp" }, { agentTools: false }), {})
  const both = await agentTools.server({ client: fakeClient(), directory: "/tmp" }, { agentTools: true })
  assert.deepEqual(Object.keys(both.tool).sort(), ["frames", "render"])
  const one = await agentTools.server({ client: fakeClient(), directory: "/tmp" }, { render: true })
  assert.deepEqual(Object.keys(one.tool), ["render"])
  assert.equal(resolveOptions({ agentTools: true, frames: false }).frames, false)
})

test("vision is read from the session model's modalities in the config; unknown means no images", async () => {
  const cache = new Map()
  assert.equal(await modelHasVision(fakeClient({ modalities: { input: ["text", "image"], output: ["text"] } }), "s1", cache), true)
  assert.equal(await modelHasVision(fakeClient({ modalities: { input: ["text"], output: ["text"] } }), "s2", cache), false)
  assert.equal(await modelHasVision(fakeClient({}), "s3", cache), false)
  assert.equal(await modelHasVision({ session: { messages: async () => { throw new Error("down") } } }, "s4", cache), false)
  assert.equal(cache.get("s1"), true)
})

test("targets: project-relative files and URLs; missing files are reported, not thrown", () => {
  assert.equal(resolveTarget("/tmp", "https://example.org/x").url, "https://example.org/x")
  assert.match(resolveTarget("/tmp", "no-such-file.html").error, /file not found/)
})

test("the text summaries name the problems and say whether an image was attached", () => {
  const r = renderText("index.html", 390, { problems: ["horizontal overflow: 1600px in a 390px viewport"], metrics: { scrollWidth: 1600, scrollHeight: 900, h1: 1, h2: 0, buttons: 1, links: 0, images: 0, minFont: 11, minContrast: 2.5 }, pdf_pages: 2 }, "/tmp/x.png", false)
  assert.match(r, /1 problem/)
  assert.match(r, /horizontal overflow/)
  assert.match(r, /A4 .*2 page/)
  assert.match(r, /not attached/)
  const f = framesText("out.mp4", { probe: { duration: 4, size_bytes: 28000, container: "mov,mp4", streams: [{ type: "video", codec: "h264", width: 256, height: 144, fps: "15/1" }] }, frames: [{ time: 1, png: "/tmp/a.png", width: 320, height: 180, brightness: 100 }] }, true)
  assert.match(f, /h264 256×144 15\/1 fps/)
  assert.match(f, /attached/)
})

test("render executes Chromium through the shura-qa Playwright and returns problems plus a PNG attachment for a vision model", { skip: !havePlaywright }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-tools-"))
  try {
    await writeFile(path.join(dir, "index.html"), PAGE)
    const hooks = await agentTools.server({ client: fakeClient({ modalities: { input: ["text", "image"], output: ["text"] } }), directory: dir }, { render: true, saveDir: dir })
    const ctx = { sessionID: "s1", directory: dir, worktree: dir, agent: "build", messageID: "m1", abort: new AbortController().signal, metadata() {}, ask: async () => {} }
    const res = await hooks.tool.render.execute({ file: "index.html", width: 390, pdf: true }, ctx)
    assert.match(res.output, /horizontal overflow/)
    assert.match(res.output, /contrast/)
    assert.match(res.output, /small tap target/)
    assert.match(res.output, /A4 .*1 page/)
    assert.equal(res.attachments.length, 1)
    assert.equal(res.attachments[0].mime, "image/png")
    assert.match(res.attachments[0].url, /^data:image\/png;base64,/)
    // a model without vision gets the same text and no attachment
    const text = await agentTools.server({ client: fakeClient({ modalities: { input: ["text"], output: ["text"] } }), directory: dir }, { render: true, saveDir: dir })
    const r2 = await text.tool.render.execute({ file: "index.html", width: 390 }, { ...ctx, sessionID: "s2" })
    assert.equal(r2.attachments, undefined)
    assert.match(r2.output, /not attached/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("frames executes ffmpeg and returns frames with an ffprobe summary", async () => {
  const src = path.join(process.env.SHURA_INTEGRATION_ROOT ?? path.join(os.homedir(), "Projects", "shura-integration"), "bench/agentic-eval/tasks_general/gm_concat/general-01/start/in.mp4")
  const have = await access(src).then(() => true, () => false)
  if (!have) return
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-tools-"))
  try {
    const hooks = await agentTools.server({ client: fakeClient(), directory: path.dirname(src) }, { frames: true, vision: true, saveDir: dir })
    const ctx = { sessionID: "s1", directory: path.dirname(src), worktree: dir, agent: "build", messageID: "m1", abort: new AbortController().signal, metadata() {}, ask: async () => {} }
    const res = await hooks.tool.frames.execute({ file: "in.mp4", count: 3, width: 320 }, ctx)
    assert.match(res.output, /h264 256×144/)
    assert.equal(res.attachments.length, 3)
    assert.equal(res.metadata.probe.duration > 3.5, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("render judges controls the way the task graders do: a link styled as a button counts, a short or invisible one is flagged (AGTOOLS1b)", { skip: !havePlaywright }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-tools-"))
  try {
    const page = (cta) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>c</title>
<style>body{margin:0;font-family:sans-serif;color:#111}article{max-width:360px;padding:16px}h1{font-size:24px}p{font-size:16px}</style></head>
<body><article class="card"><h1>shura.cpp</h1><p>A fork with a VRAM governor.</p>${cta}</article></body></html>`
    const hooks = await agentTools.server({ client: fakeClient(), directory: dir }, { render: true, vision: false, saveDir: dir })
    const ctx = { sessionID: "s1", directory: dir, worktree: dir, agent: "build", messageID: "m1", abort: new AbortController().signal, metadata() {}, ask: async () => {} }
    // the live model's shape: <a class="actions"> with 12px padding = 49px tall — fine, and listed with its size
    await writeFile(path.join(dir, "index.html"), page('<a class="actions" href="#" style="display:block;padding:14px 16px;line-height:1.3;background:#1b5fb0;color:#fff;font-size:16px">View on GitHub</a>'))
    let res = await hooks.tool.render.execute({ file: "index.html", width: 390 }, ctx)
    assert.match(res.output, /no layout problems found/)
    assert.match(res.output, /Clickable: a\.actions "View on GitHub": \d+×(4[4-9]|5\d)px/)
    // a 30px link is a small tap target
    await writeFile(path.join(dir, "index.html"), page('<a href="#" style="display:block;padding:4px;font-size:16px;color:#1b5fb0">View on GitHub</a>'))
    res = await hooks.tool.render.execute({ file: "index.html", width: 390 }, ctx)
    assert.match(res.output, /small tap target: a "View on GitHub" is \d+px tall/)
    // a hidden button is reported as invisible, and a page with no control at all says so
    await writeFile(path.join(dir, "index.html"), page('<button style="display:none">View on GitHub</button>'))
    res = await hooks.tool.render.execute({ file: "index.html", width: 390 }, ctx)
    assert.match(res.output, /invisible control/)
    assert.match(res.output, /no visible button or link at all/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
