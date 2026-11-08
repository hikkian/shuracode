// Lifelong capture (LL3c): the pure pieces of /task-save and /example.
// Nothing here touches the disk until saveTask / saveExample is called, and those are called only after the person typed the command.
// What is saved stays on this machine: ~/.local/share/shura/private/control/captured/ (tasks) and ~/.local/share/shura/examples/ (examples).
import { execFile } from "node:child_process"
import { appendFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const DEFAULT_TASK_DIR = path.join(os.homedir(), ".local/share/shura/private/control/captured")
export const DEFAULT_EXAMPLE_DIR = path.join(os.homedir(), ".local/share/shura/examples")
const MAX_PATCH = 2_000_000
const MAX_FILE = 100_000
const MAX_FILES_TOTAL = 1_000_000
const MAX_FILES_COUNT = 2_000
const MAX_TRANSCRIPT = 400_000
const MAX_PIECE = 2_000

/** The text the command files start with: the engine turns /task-save and /example into this text, which is not the person's task. */
export const COMMAND_TEXT = /^The person typed \/(task-save|example)\b/

export type StartSnapshot = {
  kind: "git" | "none"
  root: string
  scope: string // the project folder relative to the repository root ("." for the whole repository)
  commit: string | null
  patch: string // `git diff HEAD` at the start (the dirty state), "" for a clean tree
  untracked: { path: string; text: string }[] // small untracked text files at the start
  truncated: boolean // something was left out because of a limit: the start can not be replayed exactly
  failed: string | null // a git call failed or overflowed: the snapshot can not be trusted
}

export type Turn = { role: "user" | "assistant" | "tool"; text?: string; tool?: string; args?: string; output?: string; at: number }

export type TaskLog = {
  session: string
  first: string
  snapshot: Promise<StartSnapshot> | null
  users: string[]
  edits: Set<string>
  tests: { cmd: string; passed: boolean; at: number; tail: string }[]
  lastEditAt: number
  asked: boolean
  frozen: boolean // between the person's command and their next message nothing is recorded
  turns: Turn[]
  transcriptBytes: number
  turnsTruncated: boolean
  lastAssistant: string
  savedTaskId: string | null
}

export function newLog(session: string): TaskLog {
  return { session, first: "", snapshot: null, users: [], edits: new Set(), tests: [], lastEditAt: 0, asked: false, frozen: false, turns: [], transcriptBytes: 0,
    turnsTruncated: false, lastAssistant: "", savedTaskId: null }
}

type GitOut = { ok: true; out: string } | { ok: false; why: string }

function git(cwd: string, args: string[]): Promise<GitOut> {
  return new Promise(resolve => {
    execFile("git", args, { cwd, timeout: 10_000, maxBuffer: MAX_PATCH + 100_000 }, (err, stdout) =>
      resolve(err ? { ok: false, why: String((err as any).code ?? err.message).slice(0, 80) } : { ok: true, out: String(stdout) }))
  })
}

const SECRET_NAME = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa|dsa)|credentials(\.json)?|\.netrc|\.npmrc|\.pypirc|.*secrets?\.(json|ya?ml|toml))$/i
const SECRET_TEXT = new RegExp([
  "sk-[A-Za-z0-9_-]{20,}", "gh[pousr]_[A-Za-z0-9]{30,}", "AKIA[0-9A-Z]{16}", "-----BEGIN [A-Z ]*PRIVATE KEY-----", "xox[abp]-[A-Za-z0-9-]{20,}",
  "[a-z][a-z0-9+.-]*://[^\\s/:@]+:[^\\s/@]{3,}@",
  "(password|passwd|pwd|secret|secret[_-]?key|private[_-]?key|api[_-]?key|access[_-]?key|token|auth)[A-Za-z0-9_]*\\s*[:=]\\s*['\"]?[^\\s'\"]{6,}",
].join("|"), "i")
// pathspecs that keep secret-looking files out of every diff we take
const EXCLUDES = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials", "credentials.json",
  ".netrc", ".npmrc", ".pypirc", "secret.*", "secrets.*"].map(p => `:(exclude,glob)**/${p}`)

export function looksSecret(text: string): boolean {
  return SECRET_TEXT.test(text)
}
export function secretName(file: string): boolean {
  return SECRET_NAME.test(file)
}

/** The file path relative to root if it stays inside root (after resolving every link), otherwise null. */
export async function insideRoot(root: string, file: string): Promise<string | null> {
  try {
    const abs = path.resolve(root, file)
    const rel = path.relative(root, abs)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null
    const real = await realpath(abs)
    const rrel = path.relative(await realpath(root), real)
    if (!rrel || rrel.startsWith("..") || path.isAbsolute(rrel)) return null
    return rel
  } catch {
    return null
  }
}

async function readSmall(root: string, rel: string): Promise<string | null> {
  try {
    const abs = path.join(root, rel)
    const s = await lstat(abs)
    if (!s.isFile() || s.size > MAX_FILE) return null // a link, a folder, a big file: never followed
    if ((await insideRoot(root, rel)) === null) return null
    const buf = await readFile(abs)
    if (buf.includes(0)) return null
    return buf.toString("utf8")
  } catch {
    return null
  }
}

function split0(out: string): string[] {
  return out.split("\0").filter(Boolean)
}

/** The state of the project before the task: kept in memory only. */
export async function snapshotStart(directory: string): Promise<StartSnapshot> {
  const none = (failed: string | null): StartSnapshot => ({ kind: "none", root: directory, scope: ".", commit: null, patch: "", untracked: [], truncated: false, failed })
  const top = await git(directory, ["rev-parse", "--show-toplevel"])
  if (!top.ok) return none("not a git repository")
  const root = top.out.trim()
  const head = await git(root, ["rev-parse", "--verify", "HEAD"])
  if (!head.ok) return { ...none("the repository has no commit yet"), root }
  const scope = path.relative(root, directory) || "."
  const patchRun = await git(root, ["diff", "--binary", "HEAD", "--", scope, ...EXCLUDES])
  const filesRun = await git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", scope])
  if (!patchRun.ok || !filesRun.ok) return { ...none(`git failed (${!patchRun.ok ? patchRun.why : (filesRun as any).why})`), root, commit: head.out.trim() }
  let truncated = false
  const names = split0(filesRun.out)
  const untracked: { path: string; text: string }[] = []
  let total = 0
  for (const name of names) {
    if (secretName(name)) continue
    if (untracked.length >= MAX_FILES_COUNT) { truncated = true; break }
    const text = await readSmall(root, name)
    if (text === null) { truncated = true; continue }
    if (total + text.length > MAX_FILES_TOTAL) { truncated = true; break }
    total += text.length
    untracked.push({ path: name, text })
  }
  return { kind: "git", root, scope, commit: head.out.trim(), patch: patchRun.out, untracked, truncated, failed: null }
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.(test|spec)\.(js|ts|mjs|cjs|tsx)$/

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file)
}

const FAIL_MARK = /(\bFAILED\b|failures=[1-9]|errors=[1-9]|# fail [1-9]|\bTraceback\b|\bfailed\b|AssertionError|ERROR:)/i
const PASS_MARK = /(\bOK\b|# pass [1-9]|\bpassed\b|\d+ passing|All tests passed)/i

/** Did a test command pass? The engine's exit code if it gave one (not for a command that hides it: `|| true`, `; true`, a pipe), otherwise the markers of the common runners. */
export function testPassed(output: string, metadata: any, cmd = ""): boolean {
  if (/(\|\|\s*(true|:)\b|;\s*(true|:)\s*$)/.test(cmd)) return false
  const exit = metadata?.exit ?? metadata?.exitCode ?? metadata?.code
  if (typeof exit === "number") {
    if (exit !== 0) return false
    return /\|/.test(cmd.replace(/\|\|/g, "")) ? !FAIL_MARK.test(output) : true
  }
  return PASS_MARK.test(output) && !FAIL_MARK.test(output)
}

/** The files an edit tool touched, also for patch tools that carry the paths inside the patch text. */
export function editedFiles(args: any): string[] {
  const one = String(args?.filePath ?? args?.file_path ?? args?.path ?? "")
  if (one) return [one]
  const text = String(args?.patchText ?? args?.patch ?? args?.input ?? "")
  const found = new Set<string>()
  for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) found.add(m[1].trim())
  for (const m of text.matchAll(/^\+\+\+ b\/(.+)$/gm)) found.add(m[1].trim())
  return [...found]
}

/** The one question per task: edits were made, the last test run came after the last edit and passed, and nobody was asked yet. */
export function shouldAsk(log: TaskLog): boolean {
  if (log.asked || log.edits.size === 0 || log.tests.length === 0) return false
  const last = log.tests[log.tests.length - 1]
  return last.passed && last.at >= log.lastEditAt
}

export function cyrillicShare(text: string): number {
  const letters = text.match(/[A-Za-zА-Яа-яЁё]/g) ?? []
  const cyr = text.match(/[А-Яа-яЁё]/g) ?? []
  return letters.length ? cyr.length / letters.length : 0
}

export function questionText(log: TaskLog): string {
  return cyrillicShare(log.first) > 0.3
    ? "Задача решена, тест прошёл. Сохранить её как контрольную задачу для проверки Shura? Введите /task-save (или не отвечайте: ничего не сохранится)."
    : "The task is done and the test passed. Save it as a control task for checking Shura? Type /task-save (or ignore this: nothing is saved)."
}

export function addTurn(log: TaskLog, turn: Turn): void {
  if (log.frozen) return
  const size = (turn.text?.length ?? 0) + (turn.args?.length ?? 0) + (turn.output?.length ?? 0)
  log.turns.push(turn)
  log.transcriptBytes += size
  if (log.transcriptBytes <= MAX_TRANSCRIPT) return
  // over the limit: shorten the oldest tool outputs first, then drop the oldest turns, and say so
  log.turnsTruncated = true
  for (const t of log.turns) {
    if (log.transcriptBytes <= MAX_TRANSCRIPT) break
    if (t.output && t.output.length > 200) { log.transcriptBytes -= t.output.length - 200; t.output = t.output.slice(0, 200) + "…[cut]" }
  }
  while (log.transcriptBytes > MAX_TRANSCRIPT && log.turns.length > 1) {
    const t = log.turns.shift()!
    log.transcriptBytes -= (t.text?.length ?? 0) + (t.args?.length ?? 0) + (t.output?.length ?? 0)
  }
}

export function clip(value: unknown, n = MAX_PIECE): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "")
  return s.length > n ? s.slice(0, n) + "…[cut]" : s
}

function slug(text: string): string {
  return (text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project").slice(0, 40)
}

function langOf(files: string[]): string {
  const ext = (files.find(f => /\.[a-z]+$/.test(f)) ?? "").split(".").pop() ?? ""
  return ({ py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", go: "go", sh: "bash", sql: "sql" } as any)[ext] ?? "text"
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
}

const rand = () => Math.random().toString(36).slice(2, 6)

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 })
}

export type SaveResult = { ok: true; id: string; dir: string } | { ok: false; reason: string }

/** Save the task: the start (repository + commit + dirty patch + untracked files), the final state as a patch against the start commit, the tests the task changed.
 *  Only after the person's command. Written into a temporary folder and renamed, so a half-saved task never looks valid. */
export async function saveTask(log: TaskLog, taskDir: string, note: string): Promise<SaveResult> {
  const snap = log.snapshot ? await log.snapshot : null
  if (!snap || !log.first.trim()) return { ok: false, reason: "no start snapshot or no first message in this session" }
  if (snap.failed) return { ok: false, reason: `the start state could not be read (${snap.failed}); a task needs a git repository with at least one commit. Nothing was saved.` }
  const passing = [...log.tests].reverse().find(t => t.passed && t.at >= log.lastEditAt)
  const pieces = [log.first, snap.patch, note, passing?.cmd ?? "", ...snap.untracked.map(u => u.text)]
  if (pieces.some(looksSecret)) return { ok: false, reason: "the prompt or the start state contains something that looks like a secret (key, token, password); remove it and try again. Nothing was saved." }
  if (!passing && !note.trim()) {
    return { ok: false, reason: "there is no passing test run after the last change and no note saying how to check the result; type /task-save <how to check it>. Nothing was saved." }
  }
  const root = snap.root
  const solutionRun = await git(root, ["diff", "--binary", snap.commit ?? "HEAD", "--", snap.scope, ...EXCLUDES])
  const namesRun = await git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", snap.scope])
  if (!solutionRun.ok || !namesRun.ok) return { ok: false, reason: "the final changes could not be read completely (too large or git failed); nothing was saved." }
  const solution = solutionRun.out
  const startText = new Map(snap.untracked.map(u => [u.path, u.text]))
  const newFiles: { path: string; text: string }[] = []
  for (const name of split0(namesRun.out)) {
    if (secretName(name)) continue
    const text = await readSmall(root, name)
    if (text !== null && startText.get(name) !== text) newFiles.push({ path: name, text }) // new files and untracked start files the task changed
  }
  const hidden: { path: string; text: string }[] = []
  for (const file of log.edits) {
    const rel = await insideRoot(root, file)
    if (rel === null || !isTestFile(rel) || secretName(rel)) continue
    const text = await readSmall(root, rel)
    if (text !== null) hidden.push({ path: rel, text })
  }
  if ([solution, ...newFiles.map(f => f.text), ...hidden.map(h => h.text)].some(looksSecret)) {
    return { ok: false, reason: "the final changes contain something that looks like a secret; nothing was saved." }
  }
  const family = "captured_" + slug(path.basename(root))
  const id = `${family}-${stamp()}-${rand()}`
  const task = {
    id, family, kind: "captured", lang: langOf([...log.edits]), difficulty: "unknown",
    prompt: log.first, prompt_lang: cyrillicShare(log.first) > 0.3 ? "ru" : "en",
    test_cmd: passing ? ["bash", "-lc", passing.cmd] : null, check: passing ? "test_cmd" : "criterion", criterion: passing ? null : note.trim(),
    timeout_s: 900, soft: "counts", tags: ["captured", "user"], source: "user", repo: root, scope: snap.scope, commit: snap.commit,
    start: { dirty: snap.patch.length > 0, untracked: snap.untracked.map(u => u.path), truncated: snap.truncated },
    // the start tree = `git archive <commit>` + start/start.patch + start/untracked/; the final state = `git checkout <commit>` + solution/solution.patch + solution/new_files/
    solution: { base: "commit", patch: solution.length > 0, new_files: newFiles.map(f => f.path) },
    hidden_files: hidden.map(h => h.path), note: note.trim() || null, transcript_truncated: log.turnsTruncated,
    created_at: new Date().toISOString(), confirmed_by: "command:/task-save", validated: false,
    // the split into work / holdout is decided by the control-set tool from the family, not here
  }
  const dir = path.join(taskDir, family, id)
  const tmp = `${dir}.tmp-${rand()}`
  try {
    await put(path.join(tmp, "task.json"), JSON.stringify(task, null, 1))
    if (snap.patch) await put(path.join(tmp, "start", "start.patch"), snap.patch)
    for (const u of snap.untracked) await put(path.join(tmp, "start", "untracked", u.path), u.text)
    if (solution) await put(path.join(tmp, "solution", "solution.patch"), solution)
    for (const f of newFiles) await put(path.join(tmp, "solution", "new_files", f.path), f.text)
    for (const h of hidden) await put(path.join(tmp, "hidden", "files", h.path), h.text)
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 })
    await rename(tmp, dir)
    await appendFile(path.join(taskDir, "index.jsonl"), JSON.stringify({ id, family, created_at: task.created_at, repo: root }) + "\n", { mode: 0o600 })
  } catch (e: any) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return { ok: false, reason: `writing failed (${String(e?.code ?? e?.message).slice(0, 60)}); nothing was saved.` }
  }
  log.savedTaskId = id
  return { ok: true, id, dir }
}

/** Save an example (DESIGN-LL0 5.1): kind "task" = the whole run, kind "correction" = the answer that was corrected and the person's fix. */
export async function saveExample(log: TaskLog, exampleDir: string, kind: "task" | "correction", fixed: string): Promise<SaveResult> {
  const body: any = { kind, created_at: new Date().toISOString(), confirmed_by: kind === "task" ? "command:/example" : "command:/example correction", source: "user", deleted_at: null }
  if (kind === "task") {
    if (!log.first.trim()) return { ok: false, reason: "no first message in this session" }
    const passing = [...log.tests].reverse().find(t => t.passed)
    body.task = { first_message: log.first, user_messages: log.users, turns: log.turns, turns_truncated: log.turnsTruncated, test_cmd: passing?.cmd ?? null,
      test_tail: passing?.tail ?? null, edited_files: [...log.edits], system_prompt: null }
    body.control_task_id = log.savedTaskId
  } else {
    if (!fixed.trim()) return { ok: false, reason: "a correction needs the corrected text after the command" }
    if (!log.lastAssistant.trim()) return { ok: false, reason: "there is no earlier answer to correct" }
    body.correction = { corrected_answer: log.lastAssistant, fix: fixed.trim(), context: log.users.slice(-2) }
  }
  if (looksSecret(JSON.stringify(body))) return { ok: false, reason: "the example contains something that looks like a secret; nothing was saved." }
  const id = `${kind}-${stamp()}-${rand()}`
  body.id = id
  try {
    await put(path.join(exampleDir, `${id}.json`), JSON.stringify(body, null, 1))
  } catch (e: any) {
    return { ok: false, reason: `writing failed (${String(e?.code ?? e?.message).slice(0, 60)}); nothing was saved.` }
  }
  return { ok: true, id, dir: exampleDir }
}
