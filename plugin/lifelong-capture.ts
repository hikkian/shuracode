// ShuraCode plugin (LL3c): capture control tasks and training examples from real use, only with the person's yes.
// Off unless the config says {"lifelongCapture": true}: then it adds nothing to the prompt and nothing to the disk.
//  - the first message of a session and the state of the project are kept in memory only (nothing is written);
//  - when the task is done (edits, then a test run that passes) it shows ONE toast, no model tokens: "type /task-save";
//  - /task-save and /example are the person's commands; the tools capture_task / capture_example refuse to work unless the person's
//    command was the last thing that happened in this session, so the model cannot save by itself;
//  - what is saved goes only to ~/.local/share/shura/private/control/captured/ (tasks) and ~/.local/share/shura/examples/ (examples).
import type { PluginModule } from "@opencode-ai/plugin"
import type { TaskLog } from "./lib/capture.ts"
import {
  COMMAND_TEXT, DEFAULT_EXAMPLE_DIR, DEFAULT_TASK_DIR, addTurn, clip, editedFiles, newLog, questionText, saveExample, saveTask, shouldAsk, snapshotStart, testPassed,
} from "./lib/capture.ts"
import { isEditTool, isTestCommand, userText } from "./rsi2/lib.ts"

type Consent = { command: "task-save" | "example"; args: string; at: number }
const CONSENT_TTL_MS = 10 * 60 * 1000

const plugin: PluginModule & { id: string } = {
  id: "shuracode-lifelong-capture",
  server: async (input, options) => {
    if ((options as any)?.lifelongCapture !== true) return {}
    const directory = String((input as any)?.directory ?? (input as any)?.worktree ?? process.cwd())
    const taskDir = String((options as any)?.captureDir ?? DEFAULT_TASK_DIR)
    const exampleDir = String((options as any)?.exampleDir ?? DEFAULT_EXAMPLE_DIR)
    const client = (input as any)?.client
    const logs = new Map<string, TaskLog>()
    const consent = new Map<string, Consent>()
    let seq = 0
    const log = (session: string) => {
      let l = logs.get(session)
      if (!l) { l = newLog(session); logs.set(session, l) }
      return l
    }
    const takeConsent = (session: string, command: Consent["command"]): Consent | null => {
      const c = consent.get(session)
      consent.delete(session)
      if (!c || c.command !== command || Date.now() - c.at > CONSENT_TTL_MS) return null
      return c
    }
    const refuse = (what: string) => `Refused: ${what} can only be saved after the person types the command (/task-save or /example). Ask them to type it; do not try again.`

    return {
      "chat.message": async (hook: any, output: any) => {
        const session = String(hook?.sessionID ?? "")
        if (!session) return
        const text = userText(output?.parts ?? []).trim()
        if (!text || text.startsWith("[Shura")) return
        if (COMMAND_TEXT.test(text)) return // the expanded text of /task-save or /example is not the person's task
        const l = log(session)
        // a real message of the person: the command turn is over, its consent is gone
        consent.delete(session)
        l.frozen = false
        l.users.push(clip(text, 4000))
        addTurn(l, { role: "user", text: clip(text, 4000), at: ++seq })
        if (!l.first) {
          l.first = text
          l.snapshot = snapshotStart(directory) // not awaited: the engine must not wait for git; saveTask waits for it
        }
      },
      "tool.execute.before": async (hook: any) => {
        // the first change of the project waits for the start snapshot (a few git calls), so the snapshot is always the state BEFORE the task
        const snapshot = logs.get(String(hook?.sessionID ?? ""))?.snapshot
        if (snapshot) await snapshot.catch(() => {})
      },
      "tool.execute.after": async (hook: any, output: any) => {
        const session = String(hook?.sessionID ?? "")
        if (!session) return
        const l = log(session)
        const tool = String(hook?.tool ?? "")
        if (tool !== "capture_task" && tool !== "capture_example") consent.delete(session) // any other work after the command ends its consent
        if (l.frozen) return
        addTurn(l, { role: "tool", tool, args: clip(hook?.args), output: clip(output?.output), at: ++seq })
        if (isEditTool(tool)) {
          for (const file of editedFiles(hook?.args)) l.edits.add(file)
          l.lastEditAt = seq
        } else if (isTestCommand(tool, hook?.args)) {
          const out = typeof output?.output === "string" ? output.output : ""
          const cmd = String(hook?.args?.command ?? "")
          l.tests.push({ cmd, passed: testPassed(out, output?.metadata, cmd), at: seq, tail: out.slice(-1500) })
        }
      },
      "experimental.text.complete": async (hook: any, output: any) => {
        const session = String(hook?.sessionID ?? "")
        const text = String(output?.text ?? "")
        if (!session || !text) return
        const l = log(session)
        if (l.frozen) return // the answer in the command turn ("saving now...") is not the answer that is being corrected
        l.lastAssistant = text
        addTurn(l, { role: "assistant", text: clip(text, 6000), at: ++seq })
      },
      event: async ({ event }: any) => {
        const session = String(event?.properties?.sessionID ?? event?.properties?.info?.id ?? "")
        if (event?.type === "session.deleted") { logs.delete(session); consent.delete(session); return }
        if (event?.type !== "session.idle") return
        const l = logs.get(session)
        if (consent.has(session) && l?.frozen) { consent.delete(session); return } // the command turn is over, whatever the model did in it
        if (!l || !shouldAsk(l)) return
        l.asked = true // one question per task, an ignored question is not repeated
        try {
          await client?.tui?.showToast?.({ body: { message: questionText(l), variant: "info", duration: 20000 } })
        } catch {}
      },
      "command.execute.before": async (hook: any) => {
        const command = String(hook?.command ?? "")
        const session = String(hook?.sessionID ?? "")
        if (!session || (command !== "task-save" && command !== "example")) return
        consent.set(session, { command, args: String(hook?.arguments ?? ""), at: Date.now() })
        log(session).frozen = true
      },
      tool: {
        capture_task: {
          description: "Save the finished task as a control task. Works only right after the person typed /task-save; call it once and tell them in one line where it was saved or why not.",
          args: {},
          async execute(_args: any, ctx: any) {
            const session = String(ctx?.sessionID ?? "")
            const c = takeConsent(session, "task-save")
            if (!c) return refuse("a task")
            const r = await saveTask(log(session), taskDir, c.args)
            return r.ok ? `Saved the task ${r.id}. It is stored only on this machine, outside any repository.` : `Not saved: ${r.reason}`
          },
        },
        capture_example: {
          description: "Save an example for later training: the whole run (/example) or a correction (/example correction <the fixed text>). Works only right after the person typed the command.",
          args: {},
          async execute(_args: any, ctx: any) {
            const session = String(ctx?.sessionID ?? "")
            const c = takeConsent(session, "example")
            if (!c) return refuse("an example")
            const m = c.args.trim().match(/^correction\b[\s:]*([\s\S]*)$/i)
            const r = await saveExample(log(session), exampleDir, m ? "correction" : "task", m ? m[1] : "")
            return r.ok ? `Saved the example ${r.id}. It is stored only on this machine.` : `Not saved: ${r.reason}`
          },
        },
      },
    }
  },
}

export default plugin
