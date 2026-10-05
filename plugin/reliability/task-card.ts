import type { PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { estimateTokens, isEditTool, renderTaskCard } from "./core.ts"

type Card = { goal: string; plan: string[]; done: string[]; next: string }
const LARGE_RESULT_TOKENS = 20_000

function textParts(parts: any[] = []): string {
  return parts.filter(part => part?.type === "text").map(part => String(part.text ?? "")).join("\n")
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96) || "unknown"
}

const plugin: PluginModule & { id: string } = {
  id: "shuracode-task-card",
  server: async (input, options) => {
    const enabled = (options as any)?.taskCard === true
    const cards = new Map<string, Card>()
    const get = (sessionID: string) => {
      let card = cards.get(sessionID)
      if (!card) {
        card = { goal: "", plan: [], done: [], next: "" }
        cards.set(sessionID, card)
      }
      return card
    }
    const hooks: any = {
      "chat.message": async (hook, output) => {
        if (!enabled) return
        const goal = textParts(output.parts).trim()
        if (!goal) return
        cards.set(hook.sessionID, { goal: goal.slice(0, 400), plan: [], done: [], next: "Inspect the project and break the request into steps." })
      },
      event: async ({ event }) => {
        if (!enabled || event.type !== "todo.updated") return
        const { sessionID, todos } = (event as any).properties ?? {}
        if (!sessionID || !Array.isArray(todos)) return
        const card = get(sessionID)
        card.plan = todos.map((todo: any) => `${todo.status === "completed" ? "[x]" : "[ ]"} ${String(todo.content ?? "").slice(0, 200)}`).slice(0, 12)
        card.done = todos.filter((todo: any) => todo.status === "completed").map((todo: any) => String(todo.content ?? "").slice(0, 160)).slice(-8)
        const pending = todos.find((todo: any) => todo.status === "in_progress") ?? todos.find((todo: any) => todo.status === "pending")
        card.next = pending ? String(pending.content ?? "").slice(0, 200) : "Verify the result and report it."
      },
      "tool.execute.after": async (hook, output) => {
        if (!enabled) return
        const card = get(hook.sessionID)
        if (isEditTool(hook.tool)) {
          const file = (output.metadata as any)?.filediff?.file ?? hook.args?.filePath
          if (typeof file === "string" && !card.done.includes(`Edited ${file}`)) card.done.push(`Edited ${file}`)
          card.done = card.done.slice(-8)
        }

        const result = typeof output.output === "string" ? output.output : ""
        const content = Array.isArray((output as any).content)
          ? (output as any).content.filter((item: any) => item?.type === "text").map((item: any) => String(item.text ?? "")).join("\n\n")
          : result
        const tokenEstimate = estimateTokens(content)
        if (!content || tokenEstimate <= LARGE_RESULT_TOKENS) return

        const root = path.resolve(input.worktree)
        const destination = path.resolve(root, ".shuracode", "tool-results", safeId(hook.sessionID), `${safeId(hook.callID)}.txt`)
        if (!destination.startsWith(root + path.sep)) return
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, content, "utf8")
        const relative = path.relative(root, destination)
        const marker = `Large tool output (~${tokenEstimate.toLocaleString()} tokens) was saved to [${relative}]. Read that file only if needed.`
        if (typeof output.output === "string") output.output = marker
        if (output.metadata && typeof output.metadata === "object" && typeof (output.metadata as any).output === "string") {
          (output.metadata as any).output = marker
        }
        if (Array.isArray((output as any).content)) {
          for (const item of (output as any).content) if (item?.type === "text") item.text = marker
        }
        output.metadata = { ...(output.metadata as any), shuracodeLargeOutput: { path: relative, tokenEstimate } }
      },
      "experimental.chat.system.transform": async (hook, output) => {
        if (!enabled || !hook.sessionID) return
        const card = cards.get(hook.sessionID)
        if (card?.goal) {
          output.system.push(`${renderTaskCard(card)}\nKeep this card concise and update the built-in todo list as progress changes.`)
        }
      },
      "experimental.session.compacting": async (hook, output) => {
        if (!enabled) return
        const card = cards.get(hook.sessionID)
        if (!card?.goal) return
        output.context.push(`Preserve the current task card exactly in the compacted context:\n${renderTaskCard(card)}\nAfter compaction, refresh the built-in todo list and continue at Next.`)
      },
    }
    if (enabled) {
      hooks.tool = {
        shura_task_card: tool({
          description: "Update the concise task card (goal, plan, done, next) that is reinserted into context every turn.",
          args: {
            goal: tool.schema.string().max(400).optional(),
            plan: tool.schema.array(tool.schema.string().max(200)).max(12).optional(),
            done: tool.schema.array(tool.schema.string().max(160)).max(8).optional(),
            next: tool.schema.string().max(200).optional(),
          },
          async execute(args, context) {
            const card = get(context.sessionID)
            if (args.goal !== undefined) card.goal = args.goal
            if (args.plan !== undefined) card.plan = args.plan
            if (args.done !== undefined) card.done = args.done
            if (args.next !== undefined) card.next = args.next
            return { title: "Task card updated", output: renderTaskCard(card) }
          },
        }),
      }
    }
    return hooks
  },
}

export default plugin
