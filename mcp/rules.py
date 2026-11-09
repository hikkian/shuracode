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

LL4b: every enable/retire/rollback is a numbered snapshot of the layer (<skills>/<model>/versions/NNN/harness.md, CURRENT points at
the live one, a row in rule_version), the layer is limited to 12 rules and ~600 tokens, a merged rule replaces its sources when it is
enabled, `rollback` moves CURRENT back by one command, EXPERIENCE.md keeps the story, and a rule that passed the night check carries
a notice until the person decides. Storage: the same SQLite file as the memory (gateway/lifelong_store.py of Shura, tables `rule`, `rule_version`, `journal` with the same
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
MAX_ENABLED = 12            # §4.7: always-on rules per model
TOKEN_BUDGET = 600          # §4.7: the rendered personal layer, in tokens (estimated: characters / 3.5 with a 15 % margin, as rsi/budget.py)
CHARS_PER_TOKEN, TOKEN_MARGIN = 3.5, 1.15
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
    {"name": "rule_merge",
     "description": "Propose ONE rule that replaces two or more existing rules (when the layer is full or two rules overlap). The merged "
                    "text is queued for the night check like any candidate; when the person enables it, the source rules retire.",
     "inputSchema": {"type": "object", "properties": {
         "key": {"type": "string"}, "sources": {"type": "array", "items": {"type": "string"}, "description": "keys of the rules it replaces"},
         "when": {"type": "string"}, "do": {"type": "string"}, "why": {"type": "string"}, "model": {"type": "string", "enum": list(MODELS)}},
         "required": ["key", "sources", "when", "do", "why"]}},
    {"name": "rule_versions",
     "description": "List the versions of the personal layer (number, date, rules, which one is live). Read-only: rollback is the person's "
                    "terminal command.",
     "inputSchema": {"type": "object", "properties": {"model": {"type": "string", "enum": list(MODELS)}}}},
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


def est_tokens(text):
    return int(len(text) / CHARS_PER_TOKEN * TOKEN_MARGIN + 0.999)


def visible_passport(r):
    if os.environ.get('SHURACODE_MEMORY_ENABLED', '').lower() not in ('true', '1'):
        return ''
    source = escape_control(str(r['born_from'] or 'user_command')).replace('\n', ' ')
    trust = 'confirmed by user' if r['status'] == 'enabled' else 'proposed'
    return f" passport: (source: {source}, date: {r['created_at'][:10]}, trust: {trust})"


def rule_form(r):
    n = r["notes"]
    flag = "\nflag: instruction-like (reads like an instruction to the model; the person must look at it)" if n.get("flagged") else ""
    merged = f"\nreplaces: {', '.join(n['merged_from'])}" if n.get("merged_from") else ""
    gate = ""
    if n.get("gate"):
        g = n["gate"]
        gate = f"\ngate: run {g.get('run')} {g.get('decision')}: score {g.get('delta')} (lower {g.get('ci_low')}), time x{g.get('time_ratio')}, tokens x{g.get('tokens_ratio')}"
    if n.get("ablation"):
        a = n["ablation"]
        gate += f"\nablation: run {a.get('run')} {a.get('decision')} (score without it {a.get('delta')}, lower {a.get('ci_low')}); the person decides whether to retire it"
    if n.get("gate_skipped"):
        gate += f"\ngate skipped: {n['gate_skipped'].get('reason')}"
    if n.get("rolled_back"):
        gate += "\nrolled back: taken out of the layer by a rollback; enable brings it back"
    return (f"RULE {n['key']} [{r['status']}]{visible_passport(r)}\nwhen: {n['when']}\ndo: {n['do']}\nwhy: {n['why']}\nborn_from: {r['born_from']}\n"
            f"cost: {n['cost_words']} words\nmodel: {n['model']}, kind: {r['kind']}, cases: {len(r['cases'])}{flag}{merged}{gate}")


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
        """The model of the running session. SHURACODE_MODEL when set (explicit wins); else the file plugin/model-harness.ts writes
        for the engine process that started this server (<skills_dir>/CURRENT_MODEL.<pid>, pid = our parent); else the shared
        <skills_dir>/CURRENT_MODEL (the last request of any window: two windows with different models can race on it); else tiel."""
        name = (os.environ.get("SHURACODE_MODEL") or "").strip().lower()
        if name in MODELS:
            return name
        for candidate in (self.skills_dir / f"{CURRENT_MODEL_FILE}.{os.getppid()}", self.skills_dir / CURRENT_MODEL_FILE):
            try:
                name = candidate.read_text(encoding="utf-8").strip().lower()
            except OSError:
                continue
            if name in MODELS:
                return name
        return "tiel"

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
            if r["status"] == "rejected" and r["notes"].get("gate_rejected"):
                self._add_case(r["id"], why)
                return f"Rule '{key}' failed the night check earlier (§4.5); the case is recorded but it is not queued again (an explicit /rule would)."
            if r["status"] in ("enabled", "passed", "testing", "queued", "retired"):
                self._add_case(r["id"], why)
                self._journal(actor, "rule_case", f"{key} +1 ({r['status']})")
                return f"Rule '{key}' is already {r['status']}; the case is recorded ({len(r['cases']) + 1} cases)."
            sessions = {c["session"] for c in r["cases"]}
            if r["text"] != text:
                self._journal(actor, "rule_text_changed", f"{key} from: {r['text']}")
            r["notes"].pop("flagged", None)
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
            if r["text"] != text:
                # the person may have seen the old text: the change is in the history, and enable confirms the exact text shown
                self._journal(actor, "rule_text_changed", f"{key} from: {r['text']}")
            if r["notes"].get("declined"):
                self._journal(actor, "rule_declined_lifted", f"{key} was declined; re-queued by /rule with: {text}")
            r["notes"].pop("flagged", None)
            r["notes"].update(notes)
            for stale in ("declined", "gate", "gate_rejected", "gate_skipped", "rolled_back"):
                r["notes"].pop(stale, None)
            self.db.execute("UPDATE rule SET text=?, kind=?, status='queued', born_from='user_command', notes=? WHERE id=?",
                            (text, kind, json.dumps(r["notes"], ensure_ascii=False), r["id"]))
            self._add_case(r["id"], why)
            self._journal(actor, "rule_queued", f"{key} by /rule (was {r['status']})")
            return f"Rule '{key}' is queued for the night check (it was {r['status']}; cost {notes['cost_words']} words)."

    def merge(self, key, sources, when, do, why, model=None, actor="user"):
        """One rule for several (§4.7): queued like any candidate; the sources retire when the merged rule is enabled."""
        if not isinstance(sources, (list, tuple)):
            raise RuleError("sources must list at least two rule keys")
        sources = list(dict.fromkeys(slug(x) for x in sources))
        if len(sources) < 2:
            raise RuleError("sources must list at least two different rule keys")
        key, text, notes, model, kind = self._validate(key, when, do, why, model, None)
        with Tx(self.db):
            srcs = []
            for sk in sources:
                r = self._get(slug(sk), model)
                if r is None or r["status"] not in ("enabled", "passed", "queued"):
                    raise RuleError(f"source '{slug(sk)}' must be an enabled, passed or queued rule of {model}")
                srcs.append(r["notes"]["key"])
            if key in srcs or self._get(key, model) is not None:
                raise RuleError(f"'{key}' exists; a merged rule needs a new key")
            notes["merged_from"] = srcs
            rid = self._insert(text, kind, "queued", "merge:" + ",".join(srcs), notes)
            self._add_case(rid, why)
            self._journal(actor, "rule_queued", f"{key} merge of {', '.join(srcs)}")
        return f"Merged rule '{key}' is queued for the night check; when the person enables it, {', '.join(srcs)} retire (cost {notes['cost_words']} words)."

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
                elif actor != "user":
                    raise RuleError(f"no rule '{key}' for {model}: to record a refusal of a proposal pass its when, do and why")
                else:
                    why = clean(why, "why", max_chars=MAX_WHY_CHARS) if why else "declined by the person"
                    text, kind, notes = f"(declined before it was written: {key})", "rule", {"key": key, "model": model, "when": "", "do": "", "why": why, "cost_words": 0}
                notes["declined"] = True
                notes["declined_by"] = actor
                rid = self._insert(text, kind, "rejected", "declined", notes)
                self.db.execute("UPDATE rule SET retired_at=? WHERE id=?", (now_iso(), rid))
                self._journal(actor, "rule_declined", key)
                return f"Rule '{key}' is recorded as declined by the person; it will not be proposed again."
            if r["status"] == "enabled":
                raise RuleError(f"rule '{key}' is enabled; only the person can retire it in the terminal")
            if actor != "user" and r["status"] not in ("candidate", "rejected"):
                raise RuleError(f"rule '{key}' is {r['status']}; only the person can withdraw it (a queued rule came from /rule or two cases)")
            r["notes"]["declined"] = True
            r["notes"]["declined_by"] = actor
            self.db.execute("UPDATE rule SET status='rejected', retired_at=?, notes=? WHERE id=?", (now_iso(), json.dumps(r["notes"], ensure_ascii=False), r["id"]))
            self._journal(actor, "rule_declined", key)
        return f"Rule '{key}' is withdrawn (rejected by the person); it will not be proposed again."

    def notices(self, model=None):
        """Rules that passed the night check and wait for the person's word (DESIGN §11 p. 1): shown until enabled or retired."""
        out = []
        for r in self._rows("status='passed'"):
            g = r["notes"].get("gate") or {}
            if (model and r["notes"]["model"] != model) or g.get("decision") != "passed" or r["notes"].get("rolled_back"):
                continue
            out.append(f"Notice: rule '{r['notes']['key']}' ({r['notes']['model']}) passed the night check (run {g['run']}, score {g.get('delta')}): "
                       "the person can enable it in the terminal.")
        return out

    def fill_line(self, model):
        """How full the layer is, for the model and the person: «layer tiel: 11/12 rules, ~540/600 tokens»."""
        enabled = [r for r in self._rows("status='enabled'") if r["notes"]["model"] == model]
        return f"layer {model}: {len(enabled)}/{MAX_ENABLED} rules, ~{est_tokens(self._render_rows(enabled))}/{TOKEN_BUDGET} tokens"

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
        lines = self.notices(model) if not status else []
        models = sorted({r["notes"]["model"] for r in rows}) if not model else [model]
        lines += [self.fill_line(m) for m in models]
        for r in rows:
            n = r["notes"]
            flag = " !instruction-like" if n.get("flagged") else ""
            lines.append(f"- {n['key']} [{r['status']}]{flag} ({n['model']}, {len(r['cases'])} case{'s' if len(r['cases']) != 1 else ''}, {n['cost_words']} words){visible_passport(r)}: {r['text']}")
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
    def set_status(self, key, status, model=None, actor="user", force=False, expect_text=None):
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
                if expect_text is not None and r["text"] != expect_text:
                    raise RuleError(f"rule '{key}' changed while you were reading it; run enable again and read the new text")
                if r["status"] not in ("queued", "passed") and not force:
                    raise RuleError(f"rule '{key}' is {r['status']}, not queued or passed; --force enables it anyway")
                if r["notes"].get("flagged") and not force:
                    raise RuleError(f"rule '{key}' reads like an instruction to the model (flagged); read it and use --force if it is really yours")
                replaced = set(r["notes"].get("merged_from") or [])
                enabled = [x for x in self._rows("status='enabled'") if x["notes"]["model"] == model and x["notes"]["key"] not in replaced and x["id"] != r["id"]]
                if len(enabled) >= MAX_ENABLED and r["status"] != "enabled":
                    raise RuleError(f"{MAX_ENABLED} rules are already enabled for {model}; retire or merge one first (§4.7)")
                tokens = est_tokens(self._render_rows(enabled + [r]))
                if tokens > TOKEN_BUDGET:
                    raise RuleError(f"the layer of {model} would be ~{tokens} tokens, over the budget of {TOKEN_BUDGET} (§4.7); merge or retire a rule first")
                ts = now_iso()
                r["notes"].pop("rolled_back", None)
                self.db.execute("UPDATE rule SET status='enabled', enabled_at=COALESCE(enabled_at, ?), retired_at=NULL, notes=? WHERE id=?",
                                (ts, json.dumps(r["notes"], ensure_ascii=False), r["id"]))
                for x in self._rows("status IN ('enabled','passed','queued','testing','candidate')"):
                    if x["notes"]["model"] == model and x["notes"]["key"] in replaced:
                        self.db.execute("UPDATE rule SET status='retired', retired_at=? WHERE id=?", (ts, x["id"]))
                        self._journal(actor, "rule_retired", f"{x['notes']['key']} replaced by {key}")
                g = r["notes"].get("gate") or {}
                gate_run_id = g.get("run") if g.get("decision") == "passed" else None
            else:
                if r["status"] != "enabled":
                    raise RuleError(f"rule '{key}' is {r['status']}, not in the layer; use withdraw for a candidate")
                self.db.execute("UPDATE rule SET status='retired', retired_at=? WHERE id=?", (now_iso(), r["id"]))
                gate_run_id = None
            self._journal(actor, f"rule_{status}", key)
            version, text, exp = self._new_version(model, f"{status} {key}", actor, gate_run_id)
        self._write_version(model, version, text)
        if exp:
            self.experience(model, exp)
        self.render(model)
        return f"Rule '{key}' is {status}; version {version:03d} of the personal layer of {model} is live.\n{r['text']}"

    @staticmethod
    def _render_rows(rows):
        rows = sorted(rows, key=lambda r: (r["enabled_at"] or "", r["id"]))
        if not rows:
            return ""
        lines = ["Personal rules of this model, confirmed by the person and passed the check (they add to the base above, never replace it):"]
        lines += [f"- {escape_control(' '.join(str(r['text']).split()))}" for r in rows]
        return "\n".join(lines) + "\n"

    def render_text(self, model):
        return self._render_rows([r for r in self._rows("status='enabled'") if r["notes"]["model"] == model])

    # ---- versions (LL4b): numbered snapshots, CURRENT, rollback, EXPERIENCE.md ------------------------------------------------
    def versions(self, model=None):
        model = self._model(model)
        rows = self.db.execute("SELECT * FROM rule_version WHERE model=? ORDER BY number", (model,)).fetchall()
        out = []
        for v in rows:
            ids = json.loads(v["rule_ids"] or "[]")
            keys = [r["notes"]["key"] for r in self._rows() if r["id"] in ids]
            out.append({"number": v["number"], "created_at": v["created_at"], "rules": keys, "current": bool(v["is_current"]),
                        "gate_run_id": v["gate_run_id"], "tokens": est_tokens(v["rendered_harness"] or "")})
        return out

    def _new_version(self, model, reason, actor="user", gate_run_id=None):
        """Inside a transaction: snapshot the enabled rules of `model` as the next version and make it current (the files are written by
        the caller after COMMIT, so CURRENT never names a version the database does not have). The same set of rules as the current
        version makes no new version. Returns (number, text, experience line or None); the caller writes files and EXPERIENCE after COMMIT."""
        enabled = [r for r in self._rows("status='enabled'") if r["notes"]["model"] == model]
        ids = sorted(r["id"] for r in enabled)
        text = self._render_rows(enabled)
        cur = self.db.execute("SELECT number, rule_ids FROM rule_version WHERE model=? AND is_current=1", (model,)).fetchone()
        if cur is not None and sorted(json.loads(cur["rule_ids"] or "[]")) == ids:
            return cur["number"], text, None
        number = (self.db.execute("SELECT MAX(number) FROM rule_version WHERE model=?", (model,)).fetchone()[0] or 0) + 1
        self.db.execute("UPDATE rule_version SET is_current=0 WHERE model=?", (model,))
        self.db.execute("INSERT INTO rule_version(model, number, rendered_harness, rule_ids, created_at, gate_run_id, is_current) VALUES (?,?,?,?,?,?,1)",
                        (model, number, text, json.dumps(ids), now_iso(), gate_run_id))
        self._journal(actor, "version_current", f"{model} {number:03d}: {reason}")
        return number, text, f"version {number:03d} live ({reason}); {len(enabled)} rules, ~{est_tokens(text)} tokens"

    def _write_version(self, model, number, text):
        folder = self.skills_dir / model / "versions" / f"{number:03d}"
        folder.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.skills_dir / model, 0o700)
        except OSError:
            pass
        self._write_private(folder / "harness.md", text)
        self._write_private(self.skills_dir / model / "CURRENT", f"{number:03d}\n")

    def rollback(self, model=None, to=None, actor="user"):
        """One command back: CURRENT moves to the previous version (or `to`), the rules take that version's statuses (enabled there ->
        enabled; enabled now but not there -> passed, i.e. approved but not in the layer). Journaled; nothing is deleted."""
        model = self._model(model)
        with Tx(self.db):
            cur = self.db.execute("SELECT * FROM rule_version WHERE model=? AND is_current=1", (model,)).fetchone()
            if cur is None:
                raise RuleError(f"no version of the personal layer of {model} yet")
            target_no = int(to) if to is not None else cur["number"] - 1
            if target_no == cur["number"]:
                raise RuleError(f"version {target_no:03d} is the live one already")
            target = self.db.execute("SELECT * FROM rule_version WHERE model=? AND number=?", (model, target_no)).fetchone()
            if target is None:
                raise RuleError(f"no version {target_no:03d} of {model} (versions: 1..{cur['number']})")
            ids = set(json.loads(target["rule_ids"] or "[]"))
            ts = now_iso()
            for r in self._rows():
                if r["notes"]["model"] != model:
                    continue
                if r["id"] in ids and r["status"] != "enabled":
                    r["notes"].pop("rolled_back", None)
                    self.db.execute("UPDATE rule SET status='enabled', enabled_at=COALESCE(enabled_at, ?), retired_at=NULL, notes=? WHERE id=?",
                                    (ts, json.dumps(r["notes"], ensure_ascii=False), r["id"]))
                elif r["id"] not in ids and r["status"] == "enabled":
                    r["notes"]["rolled_back"] = True          # approved, taken out by the rollback: no notice nags about it
                    self.db.execute("UPDATE rule SET status='passed', notes=? WHERE id=?", (json.dumps(r["notes"], ensure_ascii=False), r["id"]))
            self.db.execute("UPDATE rule_version SET is_current=0 WHERE model=?", (model,))
            self.db.execute("UPDATE rule_version SET is_current=1 WHERE id=?", (target["id"],))
            self._journal(actor, "version_rollback", f"{model} {cur['number']:03d} -> {target_no:03d}")
        self._write_version(model, target_no, target["rendered_harness"] or "")
        self.experience(model, f"rollback {cur['number']:03d} -> {target_no:03d}")
        self.render(model)
        return f"The personal layer of {model} is back at version {target_no:03d} ({len(ids)} rules); {cur['number']:03d} stays in versions/ for a roll forward."

    def experience(self, model, line):
        """EXPERIENCE.md of the personal layer: one dated line per event (what was tried, what passed, what was rolled back)."""
        folder = self.skills_dir / model
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / "EXPERIENCE.md", "a", encoding="utf-8") as f:
            if f.tell() == 0:
                f.write(f"# Personal layer of {model}: what happened and why\n\n")
            f.write(f"- {now_iso()[:19]} {line}\n")
        try:
            os.chmod(folder / "EXPERIENCE.md", 0o600)
        except OSError:
            pass

    @staticmethod
    def _write_private(path, text):
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        tmp.write_text(text, encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)

    def render(self, model):
        """Write <skills_dir>/<model>/harness.md (only when it changed) and make sure skills/ exists. The file mirrors the current version
        (the plugin reads versions/<CURRENT>/harness.md when CURRENT exists, this file otherwise)."""
        model = self._model(model)
        folder = self.skills_dir / model
        (folder / "skills").mkdir(parents=True, exist_ok=True)
        cur = self.db.execute("SELECT rendered_harness FROM rule_version WHERE model=? AND is_current=1", (model,)).fetchone()
        text = cur["rendered_harness"] if cur is not None else self.render_text(model)
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
        current = {v["model"]: v["number"] for v in self.db.execute("SELECT model, number FROM rule_version WHERE is_current=1")}
        return {"rules": len(rows), "by_status": by, "db": str(self.path), "skills_dir": str(self.skills_dir), "session": self.session,
                "current_version": current, "notices": self.notices()}

    def versions_text(self, model=None):
        vs = self.versions(model)
        if not vs:
            return f"No versions of the personal layer of {self._model(model)} yet."
        return "\n".join(f"- {v['number']:03d}{' (live)' if v['current'] else ''} {v['created_at'][:10]}: {', '.join(v['rules']) or '(empty)'} (~{v['tokens']} tokens)" for v in vs)

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
        fns = {"rule_case": rules.case, "rule_propose": rules.propose, "rule_list": rules.list, "rule_show": rules.show, "rule_withdraw": rules.withdraw,
               "rule_merge": rules.merge, "rule_versions": rules.versions_text}
        schema = next((t for t in TOOLS if t["name"] == tool), None)
        if schema is None or tool not in fns:
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": f"unknown tool: {tool}"}], "isError": True}}
        try:
            if not isinstance(args, dict):
                raise TypeError("arguments must be an object")
            allowed = schema["inputSchema"]["properties"]
            args = {k: v for k, v in args.items() if k in allowed}    # the model cannot pass actor or anything outside the schema
            if tool in ("rule_case", "rule_propose", "rule_withdraw", "rule_merge"):
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
    ap = argparse.ArgumentParser(prog="python3 mcp/rules.py", description="ShuraCode rules (lifelong level 2)")
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
    s = sub.add_parser("versions"); s.add_argument("--model")
    s = sub.add_parser("rollback", help="one step back (or --to N); the rules take that version's statuses"); s.add_argument("--model"); s.add_argument("--to", type=int)
    s = sub.add_parser("merge", help="one rule for several: queued for the night check"); s.add_argument("key"); s.add_argument("--sources", required=True, help="comma list")
    s.add_argument("--when", required=True); s.add_argument("--do", required=True); s.add_argument("--why", required=True); s.add_argument("--model")
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
            model = rules._model(a.model)                      # resolved once: the text shown and the rule enabled are the same one
            shown = rules._get(slug(a.key), model)
            if shown is None:
                raise RuleError(f"no rule '{slug(a.key)}' for {model}")
            print(rules.show(a.key, model))                    # the person reads the exact text that goes into the prompt
            if not a.yes:
                if not sys.stdin.isatty():
                    print("error: enabling needs a person: run it in a terminal, or pass --yes after reading the text above")
                    return 1
                if input("Enable this rule in the personal layer? [y/N] ").strip().lower() not in ("y", "yes"):
                    print("not enabled")
                    return 1
            print(rules.set_status(a.key, "enabled", model, actor="code" if a.yes else "user", force=a.force, expect_text=shown["text"]))
        elif a.cmd == "disable":
            print(rules.set_status(a.key, "retired", a.model))
        elif a.cmd == "withdraw":
            print(rules.withdraw(a.key, model=a.model))
        elif a.cmd == "render":
            print(f"rendered {rules.render(a.model or rules.current_model())}")
        elif a.cmd == "versions":
            print(rules.versions_text(a.model))
        elif a.cmd == "rollback":
            print(rules.rollback(a.model, a.to))
        elif a.cmd == "merge":
            print(rules.merge(a.key, [x for x in a.sources.split(",") if x], a.when, a.do, a.why, a.model))
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
