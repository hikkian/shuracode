import type { PluginModule } from "@opencode-ai/plugin"

// The gateway ends an answer that the llama-server cut off with an error code (SHURA_RESPONSE_INTERRUPTED). The engine
// records it on the session and stops the turn; nothing else continues it, so an agent that waits for the turn to end
// waits until its own deadline. This plugin asks the model to go on once; a second cut in the same user message is left
// as the error the user (or the harness) sees.
export const INTERRUPTED = "SHURA_RESPONSE_INTERRUPTED"
export const RETRY_PREFIX = "[Shura retry]"
// A message sent the moment the engine reports idle is accepted but not run: the engine finishes the cut turn first. Measured on the
// CRASHUX1 stand: 0 ms dropped the retry, 3000 ms ran it.
export const SETTLE_MS = 3000

// The code sits in the error's message text (the gateway's JSON), so the whole error is searched, not a field.
export function isInterrupted(error: unknown): boolean {
  return JSON.stringify(error ?? "").includes(INTERRUPTED)
}

const plugin: PluginModule & { id: string } = {
  id: "shuracode-interrupt-retry",
  server: async (input, options) => {
    const enabled = (options as any)?.interruptRetry === true
    const settle = Number((options as any)?.interruptRetrySettleMs ?? SETTLE_MS)
    const retried = new Map<string, boolean>()
    // The retry waits for the session to go idle: a message sent while the cut turn is still closing is dropped by the engine.
    const pending = new Set<string>()
    return {
      "chat.message": async (hook, output) => {
        if (!enabled) return
        const text = (output.parts ?? []).filter(part => part?.type === "text").map(part => String((part as any).text ?? "")).join("\n")
        // a retry is not a new user message: it keeps the count for this user message
        if (text.startsWith(RETRY_PREFIX)) return
        retried.set(hook.sessionID, false)
      },
      event: async ({ event }) => {
        if (!enabled) return
        if (event.type === "session.error") {
          const properties = (event as any).properties ?? {}
          const sessionID = properties.sessionID
          if (!sessionID || !isInterrupted(properties.error)) return
          if (retried.get(sessionID)) return
          retried.set(sessionID, true)
          pending.add(sessionID)
          return
        }
        if (event.type !== "session.idle") return
        const sessionID = (event as any).properties?.sessionID
        if (!sessionID || !pending.has(sessionID)) return
        pending.delete(sessionID)
        await new Promise(resolve => setTimeout(resolve, settle))
        await input.client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [{
              type: "text",
              text: `${RETRY_PREFIX} The previous answer was cut off by a server failure. Continue the task from the current state of the files. If a tool call was cut off, make that call again.`,
            }],
          },
        })
      },
    }
  },
}

export default plugin
