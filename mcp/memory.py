#!/usr/bin/env python3
"""ShuraCode memory: a permanent memory shared by every ShuraCode session, as an MCP stdio server.

One fact per markdown file in ~/.local/share/shuracode/memory (override: SHURACODE_MEMORY_DIR), plus an
index, MEMORY.md, that is loaded into every session through "instructions" - so the model knows what it
knows before its first step. No vector database and no second "librarian" model: the model decides what
to remember, this code enforces the rules (one file per fact, a regenerated index, size limits, no
secrets). Files are plain text: read, edit or delete them by hand at any time.

Disk writes happen only when a memory is saved or deleted (a few KB), never per request.
"""
import fcntl
import json
import os
import re
import sys
import tempfile
from datetime import date
from pathlib import Path

MEMORY_DIR = Path(os.environ.get("SHURACODE_MEMORY_DIR") or Path.home() / ".local/share/shuracode/memory")
INDEX = "MEMORY.md"
TYPES = ("user", "feedback", "project", "reference")
MAX_MEMORIES = 100         # the index is part of every prompt; beyond this, merge or delete
INLINE_BODY = 200          # short memories are shown whole in the index, so no extra read is needed
MAX_CONTENT = 2000         # characters per memory: one fact, not a document
MAX_DESCRIPTION = 150

# Refuse obvious credentials. Memory files are plain text in $HOME and end up in every prompt.
SECRET_PATTERNS = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "a private key"),
    (r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}", "a GitHub token"),
    (r"\bsk-[A-Za-z0-9_-]{20,}", "an API key"),
    (r"\bAKIA[0-9A-Z]{16}\b", "an AWS key"),
    (r"\bxox[abprs]-[A-Za-z0-9-]{10,}", "a Slack token"),
    (r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b", "a Telegram bot token"),
    (r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.", "a JWT"),
    (r"(?i)\b(password|passwd|пароль|secret|api[_-]?key|token)\b\s*[:=]\s*\S{6,}", "a password or key"),
]

TYPE_HELP = ("user = who the user is and how they like to work; feedback = a correction or confirmed approach "
             "(add Why: and How to apply: lines); project = non-obvious project knowledge not in the code "
             "or git history; reference = pointers to external resources (URLs, dashboards)")

TOOLS = [
    {"name": "save",
     "description": "Save or update one memory (one fact per memory). Using an existing name replaces that memory. "
                    "Check the memory index first and update a memory on the same topic instead of adding a "
                    "near-duplicate. Never save passwords, tokens or personal data, or anything the code or "
                    "git history already records.",
     "inputSchema": {"type": "object", "properties": {
         "name": {"type": "string", "description": "short kebab-case slug, e.g. prefers-pytest"},
         "description": {"type": "string", "description": "the fact itself in one line, not a topic label: "
                         "'commits: English, Conventional Commits, no emoji', not 'commit style preference'"},
         "type": {"type": "string", "enum": list(TYPES), "description": TYPE_HELP},
         "content": {"type": "string", "description": "the fact, in a few lines"}},
         "required": ["name", "description", "type", "content"]}},
    {"name": "read",
     "description": "Read the full text of a memory listed in the memory index.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    {"name": "search",
     "description": "Search memories by words (name, description and text). An empty query lists all.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "delete",
     "description": "Delete a memory that is wrong or no longer true.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
]


class MemoryError(Exception):
    pass


# ------------------------------------------------------------------------------------------ storage
def slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")[:60].strip("-")
    if not s:
        raise MemoryError("name must contain latin letters or digits, e.g. 'prefers-pytest'")
    return s


def parse(text):
    """-> (meta dict, body). Tolerates hand-edited files without frontmatter."""
    meta, body = {}, text
    m = re.match(r"---\n(.*?)\n---\n?(.*)", text, re.S)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
        body = m.group(2)
    return meta, body.strip()


def load_all(root):
    out = []
    for p in sorted(root.glob("*.md")):
        if p.name == INDEX:
            continue
        try:
            meta, body = parse(p.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
        out.append({"name": p.stem, "description": meta.get("description", "").strip() or body[:80],
                    "type": meta.get("type", "reference"), "updated": meta.get("updated", ""), "body": body})
    return out


def write_atomic(path, text):
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def index_line(m):
    line = f"- {m['name']}: {m['description']}"
    body = " ".join(m["body"].split())
    if body and len(body) <= INLINE_BODY and body.lower() != m["description"].lower():
        line += f" | {body}"
    return line


def render_index(memories):
    lines = ["# ShuraCode memory",
             "",
             "What you remember from earlier sessions. Follow these. Short memories are shown whole after '|'; "
             "use memory_read for the longer ones. Keep this list accurate with memory_save / memory_delete.",
             ""]
    if not memories:
        lines.append("(empty - nothing saved yet)")
    for t in TYPES:
        group = [m for m in memories if m["type"] == t]
        if group:
            lines.append(f"## {t}")
            lines += [index_line(m) for m in group]
            lines.append("")
    other = [m for m in memories if m["type"] not in TYPES]
    if other:
        lines.append("## other")
        lines += [index_line(m) for m in other]
    return "\n".join(lines).rstrip() + "\n"


class Store:
    def __init__(self, root=MEMORY_DIR):
        self.root = Path(root)

    def _locked(self):
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        f = open(self.root / ".lock", "w")
        fcntl.flock(f, fcntl.LOCK_EX)  # several ShuraCode windows can run their own copy of this server
        return f

    def reindex(self):
        write_atomic(self.root / INDEX, render_index(load_all(self.root)))

    def save(self, name, description, type, content):
        name, description, content = slug(name), " ".join(description.split()), content.strip()
        if type not in TYPES:
            raise MemoryError(f"type must be one of {', '.join(TYPES)}")
        if not description:
            raise MemoryError("description is required")
        if len(description) > MAX_DESCRIPTION:
            raise MemoryError(f"description is {len(description)} characters; keep it under {MAX_DESCRIPTION}")
        if not content:
            raise MemoryError("content is required")
        if len(content) > MAX_CONTENT:
            raise MemoryError(f"content is {len(content)} characters; a memory holds one fact "
                              f"(under {MAX_CONTENT}) - split it or shorten it")
        for pattern, what in SECRET_PATTERNS:
            if re.search(pattern, f"{description}\n{content}"):
                raise MemoryError(f"refused: this looks like it contains {what}. Never store credentials in "
                                  "memory; describe where they live instead (e.g. 'token is in ~/.config/x').")
        with self._locked():
            path = self.root / f"{name}.md"
            existing = load_all(self.root)
            old = next((m for m in existing if m["name"] == name), None)
            if not old and len(existing) >= MAX_MEMORIES:
                raise MemoryError(f"memory is full ({MAX_MEMORIES}); delete or merge outdated memories first")
            write_atomic(path, f"---\nname: {name}\ndescription: {description}\ntype: {type}\n"
                               f"updated: {date.today().isoformat()}\n---\n\n{content}\n")
            self.reindex()
        if old:
            return f"Updated memory '{name}' (it said: {old['description']})."
        similar = [m["name"] for m in existing if overlap(m, description) >= 0.5]
        msg = f"Saved memory '{name}'."
        if similar:
            msg += (f" Similar memories exist: {', '.join(similar)}. If one covers the same topic, merge this "
                    "into it with save and delete the duplicate.")
        return msg

    def read(self, name):
        path = self.root / f"{slug(name)}.md"
        if not path.is_file():
            raise MemoryError(f"no memory named '{slug(name)}'" + self._did_you_mean(name))
        return path.read_text(encoding="utf-8")

    def delete(self, name):
        with self._locked():
            path = self.root / f"{slug(name)}.md"
            if not path.is_file():
                raise MemoryError(f"no memory named '{slug(name)}'" + self._did_you_mean(name))
            path.unlink()
            self.reindex()
        return f"Deleted memory '{slug(name)}'."

    def search(self, query, limit=8):
        memories = load_all(self.root)
        words = tokens(query)
        if not words:
            return "\n".join(f"- {m['name']} ({m['type']}): {m['description']}" for m in memories) or "No memories yet."
        scored = []
        for m in memories:
            name, desc, body = (" ".join(tokens(x)) for x in (m["name"].replace("-", " "), m["description"], m["body"]))
            score = sum(3 * (w in name) + 2 * (w in desc) + (w in body) for w in words)
            if score:
                line = next((ln.strip() for ln in m["body"].splitlines() if any(w in ln.lower() for w in words)), "")
                scored.append((score, m, line))
        if not scored:
            return f"Nothing found for '{query}'."
        scored.sort(key=lambda x: -x[0])
        return "\n".join(f"- {m['name']} ({m['type']}): {m['description']}" + (f"\n    > {line[:160]}" if line else "")
                         for _, m, line in scored[:limit])

    def _did_you_mean(self, name):
        near = [m["name"] for m in load_all(self.root) if set(tokens(name)) & set(tokens(m["name"].replace("-", " ")))]
        return f". Did you mean: {', '.join(near[:3])}?" if near else ""


def tokens(text):
    return [w for w in re.findall(r"\w+", text.lower()) if len(w) > 1]


def overlap(memory, description):
    a, b = set(tokens(memory["description"])), set(tokens(description))
    return len(a & b) / max(1, min(len(a), len(b)))


# ---------------------------------------------------------------------------------------------- MCP
def handle(store, msg):
    """One JSON-RPC message -> response dict, or None for notifications."""
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None
    if method == "initialize":
        version = msg.get("params", {}).get("protocolVersion", "2025-06-18")
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": version, "capabilities": {"tools": {}},
            "serverInfo": {"name": "shuracode-memory", "version": "1.0"},
            "instructions": "Persistent memory shared by all sessions and projects. Its index ('# ShuraCode memory') is already in your instructions: memory_read for details, memory_save to remember, memory_delete to forget."}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = msg.get("params", {})
        tool, args = params.get("name"), params.get("arguments") or {}
        try:
            fn = {"save": store.save, "read": store.read, "search": store.search, "delete": store.delete}[tool]
            text, error = fn(**args), False
        except KeyError:
            text, error = f"unknown tool: {tool}", True
        except TypeError as e:
            text, error = f"bad arguments for {tool}: {e}", True
        except (MemoryError, OSError) as e:
            text, error = str(e), True
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}], "isError": error}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}


def main():
    store = Store()
    try:
        with store._locked():
            store.reindex()  # picks up files edited or deleted by hand since the last run
    except OSError as e:
        print(f"[shuracode-memory] cannot open {store.root}: {e}", file=sys.stderr)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        reply = handle(store, msg)
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
