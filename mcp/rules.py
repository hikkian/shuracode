#!/usr/bin/env python3
"""ShuraCode rules (lifelong level 2, LL4a): candidate rules for a model's personal harness layer, as an MCP stdio server and a CLI.

A rule is one short paragraph, "when <situation> -> do <action>", born from the person's own words (DESIGN-LL0 §2, §4). The model
never writes a rule into the prompt by itself:

* a confirmed signal (a correction, "do it this way", "never do that") is recorded as a *case* with `rule_case`; one case is a note,
  not a rule ("once");
* the second case for the same rule from another session (an independent situation) makes the rule a *candidate* with status
  `queued`: it waits for the night check (the gate, LL5), where it is measured against the person's control set;
* an explicit `/rule` (`rule_propose`) queues the rule at once, because the person asked for it;
* `rule_withdraw` records that the person declined it, and the same rule is not proposed again;
* enabling a rule (after the gate, or by the person's own word in the terminal) renders the model's personal layer
  `~/.local/share/shura/skills/<model>/harness.md`, which plugin/model-harness.ts adds after the base harness.

Storage: the same SQLite file as the memory (gateway/lifelong_store.py of Shura, tables `rule`, `rule_version`, `journal` with the same
DDL, plus `rule_case`); the file is created here with the same definitions when Shura's module is not around. Standard library only.
Versions, rollback and the prompt limits of §4.7 are LL4b; the gate runner is LL5.
"""
import json
import os
import re
import socket
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from memory import SECRET_PATTERNS, MemoryError, slug as _slug  # noqa: E402  (the memory server's own rules for keys and credentials)

MEMORY_DIR = Path(os.environ.get("SHURACODE_MEMORY_DIR") or Path.home() / ".local/share/shuracode/memory")
DB_PATH = Path(os.environ.get("SHURA_LIFELONG_DB") or (MEMORY_DIR / "lifelong.sqlite" if os.environ.get("SHURACODE_MEMORY_DIR")
                                                      else Path.home() / ".local/share/shura/lifelong.sqlite"))
SKILLS_DIR = Path(os.environ.get("SHURA_SKILLS_DIR") or Path.home() / ".local/share/shura/skills")
MODELS = ("tiel", "sage", "gemma")
CURRENT_MODEL_FILE = "CURRENT_MODEL"      # written by plugin/model-harness.ts on every request: the model key of the running session
STATUSES = ("candidate", "queued", "testing", "passed", "enabled", "rejected", "retired")
KINDS = ("rule", "procedure")
MAX_WHEN_WORDS, MAX_DO_WORDS, MAX_RULE_WORDS = 25, 40, 60
MAX_WHY_CHARS = 200
MAX_ENABLED = 12            # §4.7: always-on rules per model (the token budget is checked by the gate, LL4b/LL5)
# the same escaping as Shura's knowledge store (gateway/lifelong_store.py): template markers never reach a prompt raw
CONTROL_TOKENS = ["<|im_start|>", "<|im_end|>", "<|endoftext|>", "<|start_header_id|>", "<|end_header_id|>", "<|eot_id|>",
                  "<start_of_turn>", "<end_of_turn>", "<tool_call>", "</tool_call>", "<tool_response>", "</tool_response>",
                  "<think>", "</think>", "<function=", "</function>", "<parameter=", "</parameter>", "[INST]", "[/INST]", "<<SYS>>", "<</SYS>>",
                  "<bos>", "<eos>", "<start_of_image>", "<end_of_image>", "<start_of_audio>", "<end_of_audio>"]
CONTROL_RE = re.compile(r"(?i)<\|[^<>\n]{1,60}>")
INVISIBLE_RE = re.compile("[\u200b\u2060\ufeff\u00ad]")
INSTRUCTION_RE = re.compile(r"(?i)(ignore (all |the )?(previous|prior|above) (instructions|messages|rules)|disregard (the )?(previous|above)|"
                            r"you are now |from now on you (are|will|must)|^\s*system\s*:|теперь ты |забудь (все|всё|предыдущие) инструкци|"
                            r"игнорируй (предыдущие|все) (инструкции|указания)|act as (the )?system|new instructions:|curl [^ ]+ *\| *sh)")


def escape_control(text):
    out = INVISIBLE_RE.sub("", str(text))
    for tok in CONTROL_TOKENS:
        if tok.lower() in out.lower():
            out = re.sub(re.escape(tok), lambda m: m.group(0).replace("<", "〈").replace(">", "〉").replace("[", "［").replace("]", "］"), out, flags=re.I)
    return CONTROL_RE.sub(lambda m: m.group(0).replace("<", "〈").replace(">", "〉"), out)


def looks_like_instruction(text):
    return bool(INSTRUCTION_RE.search(text or ""))

# the server process is one ShuraCode session: two cases from different processes are independent situations (§2.3 p. 3)
SESSION = os.environ.get("SHURACODE_SESSION") or f"{socket.gethostname()}:{os.getpid()}:{int(time.time())}"

SCHEMA = """
CREATE TABLE IF NOT EXISTS rule(id INTEGER PRIMARY KEY, text TEXT, kind TEXT CHECK (kind IN ('rule','procedure','skill')),
  status TEXT CHECK (status IN ('candidate','queued','testing','passed','enabled','rejected','retired')), born_from TEXT,
  created_at TEXT, enabled_at TEXT, retired_at TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS rule_version(id INTEGER PRIMARY KEY, model TEXT, number INTEGER, rendered_harness TEXT, rule_ids TEXT,
  created_at TEXT, gate_run_id INTEGER, is_current INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY, ts TEXT, actor TEXT CHECK (actor IN ('user','shura','code')), event TEXT,
  memory_id INTEGER, rule_version_id INTEGER, ref TEXT);
CREATE TABLE IF NOT EXISTS rule_case(id INTEGER PRIMARY KEY, rule_id INTEGER REFERENCES rule(id), session TEXT, ts TEXT, why TEXT, ref TEXT);
"""

TOOLS = [
    {"name": "rule_case",
     "description": "Record one confirmed case for a rule about how to work (after the person corrected you, said 'do it this way' "
                    "or 'never do that' AND confirmed saving it). One case is only a note; the second case from another session "
                    "makes the rule a candidate (queued) for the night check. Never enables anything.",
     "inputSchema": {"type": "object", "properties": {
         "key": {"type": "string", "description": "short kebab-case name of the rule, e.g. run-tests-before-done"},
         "when": {"type": "string", "description": "in which tasks or situations (one line, under 25 words)"},
         "do": {"type": "string", "description": "what exactly to do, checkable (under 40 words)"},
         "why": {"type": "string", "description": "the person's own words, one line"},
         "model": {"type": "string", "enum": list(MODELS), "description": "the model the rule is for (default: the current one)"},
         "kind": {"type": "string", "enum": list(KINDS)}},
         "required": ["key", "when", "do", "why"]}},
    {"name": "rule_propose",
     "description": "Queue a rule for the night check at once because the person asked for it explicitly (/rule). Same fields as rule_case.",
     "inputSchema": {"type": "object", "properties": {
         "key": {"type": "string"}, "when": {"type": "string"}, "do": {"type": "string"}, "why": {"type": "string"},
         "model": {"type": "string", "enum": list(MODELS)}, "kind": {"type": "string", "enum": list(KINDS)}},
         "required": ["key", "when", "do", "why"]}},
    {"name": "rule_list",
     "description": "List the rules with their status (candidate = one case, queued = waits for the night check, enabled = in the "
                    "personal layer, rejected/retired). Optional filter by status or model.",
     "inputSchema": {"type": "object", "properties": {"status": {"type": "string", "enum": list(STATUSES)},
                                                      "model": {"type": "string", "enum": list(MODELS)}}}},
    {"name": "rule_show",
     "description": "Show one rule in full: its RULE form, cases, status history.",
     "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}},
    {"name": "rule_withdraw",
     "description": "The person declined this rule ('no, don't'): mark it rejected so it is not proposed again. For a proposal that was "
                    "never recorded, pass when/do/why too so the refusal is remembered.",
     "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}, "when": {"type": "string"}, "do": {"type": "string"},
                                                      "why": {"type": "string"}, "model": {"type": "string", "enum": list(MODELS)}},
                     "required": ["key"]}},
]


class RuleError(Exception):
    pass


def slug(name):
    try:
        return _slug(name)
    except MemoryError as e:
        raise RuleError(str(e))


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())


def words(text):
    return len(re.findall(r"\S+", text or ""))


def clean(text, label, max_words=None, max_chars=None):
    if not isinstance(text, str):
        raise RuleError(f"{label} must be a string")
    text = " ".join(text.split())
    if not text:
        raise RuleError(f"{label} is required")
    if max_words and words(text) > max_words:
        raise RuleError(f"{label} is {words(text)} words; keep it under {max_words} (a rule is one short paragraph)")
    if max_chars and len(text) > max_chars:
        raise RuleError(f"{label} is {len(text)} characters; keep it under {max_chars}")
    text = INVISIBLE_RE.sub("", text)
    for pattern, what in SECRET_PATTERNS:
        if re.search(pattern, text):
            raise RuleError(f"refused: {label} looks like it contains {what}; a rule never holds credentials")
    return escape_control(text)


def rule_text(when, do):
    text = f"When {when.rstrip('.')}: {do.rstrip('.')}."
    if words(text) > MAX_RULE_WORDS:
        raise RuleError(f"the rule is {words(text)} words; keep when + do under {MAX_RULE_WORDS} words")
    return text


def rule_form(r):
    n = r["notes"]
    flag = "\nflag: instruction-like (reads like an instruction to the model; the person must look at it)" if n.get("flagged") else ""
    return (f"RULE {n['key']} [{r['status']}]\nwhen: {n['when']}\ndo: {n['do']}\nwhy: {n['why']}\nborn_from: {r['born_from']}\n"
            f"cost: {n['cost_words']} words\nmodel: {n['model']}, kind: {r['kind']}, cases: {len(r['cases'])}{flag}")


class Rules:
    """The rule store. Every public method is one short transaction on the shared SQLite file."""

    def __init__(self, db_path=DB_PATH, skills_dir=SKILLS_DIR, session=SESSION):
        self.path, self.skills_dir, self.session = Path(db_path), Path(skills_dir), session
        if not self.path.parent.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(self.path.parent, 0o700)
            except OSError:
                pass
        fresh = not self.path.exists() or self.path.stat().st_size == 0
        self.db = sqlite3.connect(str(self.path), isolation_level=None, check_same_thread=False, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA busy_timeout=10000")
        if fresh:
            self.db.execute("PRAGMA page_size=1024")          # the same file layout as Shura's store: fewer bytes per write on the SSD
        for attempt in range(5):
            try:
                self.db.execute("PRAGMA journal_mode=WAL")
                break
            except sqlite3.OperationalError:
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA secure_delete=ON")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    # ---- internals ----------------------------------------------------------------------------------------------------------
    def _journal(self, actor, event, ref=None):
        self.db.execute("INSERT INTO journal(ts, actor, event, ref) VALUES (?,?,?,?)", (now_iso(), actor, event, ref))

    def _rows(self, where="1", args=()):
        out = []
        for r in self.db.execute(f"SELECT * FROM rule WHERE kind IN ('rule','procedure') AND {where} ORDER BY id", args):
            try:
                notes = json.loads(r["notes"] or "{}")
            except ValueError:
                notes = {}
            if "key" not in notes:
                continue          # a rule row written by another tool (LL4b/LL5 may add its own); not ours to show
            d = dict(r)
            d["notes"] = notes
            d["cases"] = [dict(c) for c in self.db.execute("SELECT * FROM rule_case WHERE rule_id=? ORDER BY id", (r["id"],))]
            out.append(d)
        return out

    def current_model(self):
        """The model of the running session: written by plugin/model-harness.ts into <skills_dir>/CURRENT_MODEL on every request;
        SHURACODE_MODEL for tests; tiel when nothing says otherwise."""
        try:
            name = (self.skills_dir / CURRENT_MODEL_FILE).read_text(encoding="utf-8").strip().lower()
        except OSError:
            name = ""
        name = name or (os.environ.get("SHURACODE_MODEL") or "").lower() or "tiel"
        return name if name in MODELS else "tiel"

    def _model(self, model):
        model = (model or self.current_model()).lower()
        if model not in MODELS:
            raise RuleError(f"model must be one of {', '.join(MODELS)}")
        return model

    def _get(self, key, model):
        """A rule is one per (key, model): a case for Tiel and a case for Sage are two rules, not two cases of one."""
        for r in self._rows():
            if r["notes"]["key"] == key and r["notes"]["model"] == model:
                return r
        return None

    def _validate(self, key, when, do, why, model, kind):
        key = slug(key)
        when = clean(when, "when", max_words=MAX_WHEN_WORDS)
        do = clean(do, "do", max_words=MAX_DO_WORDS)
        why = clean(why, "why", max_chars=MAX_WHY_CHARS)
        model = self._model(model)
        kind = kind or "rule"
        if kind not in KINDS:
            raise RuleError(f"kind must be one of {', '.join(KINDS)}")
        text = rule_text(when, do)
        notes = {"key": key, "model": model, "when": when, "do": do, "why": why, "cost_words": words(text)}
        if looks_like_instruction(f"{when}\n{do}\n{why}"):
            notes["flagged"] = "instruction-like"
        return key, text, notes, model, kind

    def _insert(self, text, kind, status, born_from, notes):
        cur = self.db.execute("INSERT INTO rule(text, kind, status, born_from, created_at, notes) VALUES (?,?,?,?,?,?)",
                              (text, kind, status, born_from, now_iso(), json.dumps(notes, ensure_ascii=False)))
        return cur.lastrowid

    def _add_case(self, rule_id, why, ref=None):
        self.db.execute("INSERT INTO rule_case(rule_id, session, ts, why, ref) VALUES (?,?,?,?,?)", (rule_id, self.session, now_iso(), why, ref))

    # ---- the tools ------------------------------------------------------------------------------------------------------------
    def case(self, key, when, do, why, model=None, kind=None, actor="shura"):
        """One confirmed case. First case -> candidate ("once"); a case from another session -> queued; the same session only
        refreshes the text. A rule the person declined is not proposed again."""
        key, text, notes, model, kind = self._validate(key, when, do, why, model, kind)
        with Tx(self.db):
            r = self._get(key, model)
            if r is None:
                rid = self._insert(text, kind, "candidate", f"signal:{self.session}", notes)
                self._add_case(rid, why)
                self._journal(actor, "rule_case", f"{key} #1 (candidate)")
                return (f"Noted the first case for rule '{key}' (candidate: one case so far, not a rule yet). It is queued for the night "
                        "check after a second case in another session, or at once with /rule.")
            if r["status"] == "rejected" and r["notes"].get("declined"):
                return f"Rule '{key}' was declined by the person earlier; it is not proposed again (an explicit /rule would queue it)."
            if r["status"] in ("enabled", "passed", "testing", "queued", "retired"):
                self._add_case(r["id"], why)
                self._journal(actor, "rule_case", f"{key} +1 ({r['status']})")
                return f"Rule '{key}' is already {r['status']}; the case is recorded ({len(r['cases']) + 1} cases)."
            sessions = {c["session"] for c in r["cases"]}
            if sessions == {self.session}:
                r["notes"].update(notes)
                self.db.execute("UPDATE rule SET text=?, kind=?, notes=? WHERE id=?", (text, kind, json.dumps(r["notes"], ensure_ascii=False), r["id"]))
                self.db.execute("UPDATE rule_case SET why=?, ts=? WHERE rule_id=? AND session=?", (why, now_iso(), r["id"], self.session))
                self._journal(actor, "rule_case", f"{key} refreshed (same session)")
                return f"Same session as the first case: the text of candidate '{key}' is refreshed. A second case from another session queues it."
            r["notes"].update(notes)
            self.db.execute("UPDATE rule SET text=?, kind=?, status='queued', notes=? WHERE id=?",
                            (text, kind, json.dumps(r["notes"], ensure_ascii=False), r["id"]))
            self._add_case(r["id"], why)
            self._journal(actor, "rule_queued", f"{key} after {len(r['cases']) + 1} independent cases")
            return f"Second independent case: rule '{key}' is now queued for the night check (cost {notes['cost_words']} words)."

    def propose(self, key, when, do, why, model=None, kind=None, actor="user"):
        """An explicit /rule: queued at once."""
        key, text, notes, model, kind = self._validate(key, when, do, why, model, kind)
        with Tx(self.db):
            r = self._get(key, model)
            if r is None:
                rid = self._insert(text, kind, "queued", "user_command", notes)
                self._add_case(rid, why)
                self._journal(actor, "rule_queued", f"{key} by /rule")
                return f"Rule '{key}' is queued for the night check (cost {notes['cost_words']} words). Nothing changes in the prompt until it passes and the person enables it."
            if r["status"] in ("enabled", "passed", "testing"):
                return f"Rule '{key}' is already {r['status']}; its text is not changed (/rule a new key for a different rule)."
            if r["status"] == "queued" and r["text"] != text:
                # the person already saw the queued text: a new text under the same key becomes a new queued text only with history
                self._journal(actor, "rule_text_changed", f"{key} from: {r['text']}")
            r["notes"].update(notes)
            r["notes"].pop("declined", None)
            self.db.execute("UPDATE rule SET text=?, kind=?, status='queued', born_from='user_command', notes=? WHERE id=?",
                            (text, kind, json.dumps(r["notes"], ensure_ascii=False), r["id"]))
            self._add_case(r["id"], why)
            self._journal(actor, "rule_queued", f"{key} by /rule (was {r['status']})")
            return f"Rule '{key}' is queued for the night check (it was {r['status']}; cost {notes['cost_words']} words)."

    def withdraw(self, key, when=None, do=None, why=None, model=None, actor="user"):
        """The person said no. A proposal that was never recorded is recorded as rejected (with its text when given), so the same
        key is not proposed again. The model (actor shura) may withdraw only candidates and queued rules it could have created."""
        key = slug(key)
        model = self._model(model)
        with Tx(self.db):
            r = self._get(key, model)
            if r is None:
                if when and do:
                    key, text, notes, model, kind = self._validate(key, when, do, why or "declined by the person", model, None)
                else:
                    text, kind, notes = f"(declined before it was written: {key})", "rule", {"key": key, "model": model, "when": when or "", "do": do or "",
                                                                                               "why": why or "declined by the person", "cost_words": 0}
                notes["declined"] = True
                rid = self._insert(text, kind, "rejected", "declined", notes)
                self.db.execute("UPDATE rule SET retired_at=? WHERE id=?", (now_iso(), rid))
                self._journal(actor, "rule_declined", key)
                return f"Rule '{key}' is recorded as declined by the person; it will not be proposed again."
            if r["status"] == "enabled":
                raise RuleError(f"rule '{key}' is enabled; only the person can retire it in the terminal")
            if actor != "user" and r["status"] not in ("candidate", "queued", "rejected"):
                raise RuleError(f"rule '{key}' is {r['status']}; only the person can withdraw it")
            r["notes"]["declined"] = True
            self.db.execute("UPDATE rule SET status='rejected', retired_at=?, notes=? WHERE id=?", (now_iso(), json.dumps(r["notes"], ensure_ascii=False), r["id"]))
            self._journal(actor, "rule_declined", key)
        return f"Rule '{key}' is withdrawn (rejected by the person); it will not be proposed again."

    def list(self, status=None, model=None):
        rows = self._rows()
        if status:
            if status not in STATUSES:
                raise RuleError(f"status must be one of {', '.join(STATUSES)}")
            rows = [r for r in rows if r["status"] == status]
        if model:
            rows = [r for r in rows if r["notes"]["model"] == model]
        if not rows:
            return "No rules yet." if not (status or model) else "No rules match."
        lines = []
        for r in rows:
            n = r["notes"]
            flag = " !instruction-like" if n.get("flagged") else ""
            lines.append(f"- {n['key']} [{r['status']}]{flag} ({n['model']}, {len(r['cases'])} case{'s' if len(r['cases']) != 1 else ''}, {n['cost_words']} words): {r['text']}")
        return "\n".join(lines)

    def show(self, key, model=None):
        r = self._get(slug(key), self._model(model))
        if r is None:
            raise RuleError(f"no rule '{slug(key)}' for {self._model(model)}")
        cases = "\n".join(f"  - {c['ts'][:10]} session {c['session'][:24]}: {c['why']}" for c in r["cases"]) or "  (none)"
        events = "\n".join(f"  - {j['ts'][:19]} {j['actor']}: {j['event']}" for j in
                           self.db.execute("SELECT * FROM journal WHERE ref = ? OR ref LIKE ? ORDER BY id", (r["notes"]["key"], r["notes"]["key"] + " %")))
        return f"{rule_form(r)}\ncases:\n{cases}\nhistory:\n{events}"

    # ---- the personal layer (rendered from enabled rules) -------------------------------------------------------------------
    def set_status(self, key, status, model=None, actor="user", force=False):
        """Terminal-only (the model has no tool for it): enable or retire a rule by the person's word; renders the layer. Enabling
        takes a queued or passed rule (anything else, and a rule flagged instruction-like, only with force) and returns its text."""
        key = slug(key)
        model = self._model(model)
        if status not in ("enabled", "retired"):
            raise RuleError("status must be enabled or retired")
        with Tx(self.db):
            r = self._get(key, model)
            if r is None:
                raise RuleError(f"no rule '{key}' for {model}")
            if status == "enabled":
                if r["status"] not in ("queued", "passed") and not force:
                    raise RuleError(f"rule '{key}' is {r['status']}, not queued or passed; --force enables it anyway")
                if r["notes"].get("flagged") and not force:
                    raise RuleError(f"rule '{key}' reads like an instruction to the model (flagged); read it and use --force if it is really yours")
                enabled = [x for x in self._rows("status='enabled'") if x["notes"]["model"] == model]
                if len(enabled) >= MAX_ENABLED and r["status"] != "enabled":
                    raise RuleError(f"{MAX_ENABLED} rules are already enabled for {model}; retire or merge one first (§4.7)")
                self.db.execute("UPDATE rule SET status='enabled', enabled_at=?, retired_at=NULL WHERE id=?", (now_iso(), r["id"]))
            else:
                self.db.execute("UPDATE rule SET status='retired', retired_at=? WHERE id=?", (now_iso(), r["id"]))
            self._journal(actor, f"rule_{status}", key)
        self.render(model)
        return f"Rule '{key}' is {status}; the personal layer of {model} is rendered.\n{r['text']}"

    def render_text(self, model):
        rows = sorted((r for r in self._rows("status='enabled'") if r["notes"]["model"] == model), key=lambda r: r["enabled_at"] or "")
        if not rows:
            return ""
        lines = ["Personal rules of this model, confirmed by the person and passed the check (they add to the base above, never replace it):"]
        lines += [f"- {r['text']}" for r in rows]
        return "\n".join(lines) + "\n"

    def render(self, model):
        """Write <skills_dir>/<model>/harness.md (only when it changed) and make sure skills/ exists."""
        model = self._model(model)
        folder = self.skills_dir / model
        (folder / "skills").mkdir(parents=True, exist_ok=True)
        text = self.render_text(model)
        target = folder / "harness.md"
        if target.exists() and target.read_text(encoding="utf-8") == text:
            return target
        tmp = folder / f".harness.md.{os.getpid()}.tmp"
        tmp.write_text(text, encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
        return target

    def status(self):
        rows = self._rows()
        by = {}
        for r in rows:
            by[r["status"]] = by.get(r["status"], 0) + 1
        return {"rules": len(rows), "by_status": by, "db": str(self.path), "skills_dir": str(self.skills_dir), "session": self.session}

    def close(self):
        self.db.close()


class Tx:
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        self.db.execute("BEGIN IMMEDIATE")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.db.execute("COMMIT" if exc_type is None else "ROLLBACK")
        return False


# ---------------------------------------------------------------------------------------------- MCP
def handle(rules, msg):
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None
    if method == "initialize":
        version = msg.get("params", {}).get("protocolVersion", "2025-06-18")
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": version, "capabilities": {"tools": {}},
            "serverInfo": {"name": "shuracode-rules", "version": "0.1"},
            "instructions": "Rules about how to work (level 2). After the person confirms a correction or a 'do it this way', record one "
                            "case with rule_case; two independent cases, or /rule, queue the rule for the night check. You never enable "
                            "a rule yourself; rule_list shows the queue and what is enabled."}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = msg.get("params", {})
        tool, args = params.get("name"), params.get("arguments") or {}
        fns = {"rule_case": rules.case, "rule_propose": rules.propose, "rule_list": rules.list, "rule_show": rules.show, "rule_withdraw": rules.withdraw}
        schema = next((t for t in TOOLS if t["name"] == tool), None)
        if schema is None or tool not in fns:
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": f"unknown tool: {tool}"}], "isError": True}}
        try:
            if not isinstance(args, dict):
                raise TypeError("arguments must be an object")
            allowed = schema["inputSchema"]["properties"]
            args = {k: v for k, v in args.items() if k in allowed}    # the model cannot pass actor or anything outside the schema
            if tool in ("rule_case", "rule_propose", "rule_withdraw"):
                args["actor"] = "shura"                                 # the journal says who really called: the model, not the person
            text, error = fns[tool](**args), False
        except TypeError as e:
            text, error = f"bad arguments for {tool}: {e}", True
        except (RuleError, MemoryError, OSError, sqlite3.Error, ValueError, AttributeError) as e:
            text, error = str(e), True
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}], "isError": error}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}


def serve():
    try:
        rules = Rules()
    except (OSError, sqlite3.Error) as e:
        print(f"[shuracode-rules] cannot open the rule store: {e}", file=sys.stderr)
        return 1
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        reply = handle(rules, msg)
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


# ---------------------------------------------------------------------------------------------- CLI
def main(argv=None):
    """Terminal use (the person): list | show <key> | enable <key> | disable <key> | withdraw <key> | render [model] | status.
    Without a subcommand the MCP server runs on stdin/stdout."""
    import argparse
    ap = argparse.ArgumentParser(prog="shuracode-rules", description="ShuraCode rules (lifelong level 2)")
    ap.add_argument("--db", default=str(DB_PATH))
    ap.add_argument("--skills-dir", default=str(SKILLS_DIR))
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("list"); s.add_argument("--status"); s.add_argument("--model")
    s = sub.add_parser("show"); s.add_argument("key"); s.add_argument("--model")
    s = sub.add_parser("enable", help="by the person's word: puts a queued or passed rule into the personal layer (the gate is LL5)")
    s.add_argument("key"); s.add_argument("--model"); s.add_argument("--force", action="store_true", help="also a candidate, rejected or flagged rule")
    s.add_argument("--yes", action="store_true", help="do not ask for confirmation (the text is still printed)")
    s = sub.add_parser("disable"); s.add_argument("key"); s.add_argument("--model")
    s = sub.add_parser("withdraw"); s.add_argument("key"); s.add_argument("--model")
    s = sub.add_parser("render"); s.add_argument("model", nargs="?", default=None)
    sub.add_parser("status")
    sub.add_parser("serve")
    a = ap.parse_args(argv)
    if a.cmd in (None, "serve"):
        return serve()
    try:
        rules = Rules(a.db, a.skills_dir)
    except (OSError, sqlite3.Error) as e:
        print(f"error: cannot open {a.db}: {e}")
        return 1
    try:
        if a.cmd == "list":
            print(rules.list(a.status, a.model))
        elif a.cmd == "show":
            print(rules.show(a.key, a.model))
        elif a.cmd == "enable":
            print(rules.show(a.key, a.model))                 # the person reads the exact text that goes into the prompt
            if not a.yes:
                if not sys.stdin.isatty():
                    print("error: enabling needs a person: run it in a terminal, or pass --yes after reading the text above")
                    return 1
                if input("Enable this rule in the personal layer? [y/N] ").strip().lower() not in ("y", "yes"):
                    print("not enabled")
                    return 1
            print(rules.set_status(a.key, "enabled", a.model, force=a.force))
        elif a.cmd == "disable":
            print(rules.set_status(a.key, "retired", a.model))
        elif a.cmd == "withdraw":
            print(rules.withdraw(a.key, model=a.model))
        elif a.cmd == "render":
            print(f"rendered {rules.render(a.model or rules.current_model())}")
        else:
            print(json.dumps(rules.status(), ensure_ascii=False, indent=1))
        return 0
    except (RuleError, sqlite3.Error, OSError) as e:
        print(f"error: {e}")
        return 1
    finally:
        rules.close()


if __name__ == "__main__":
    raise SystemExit(main())
