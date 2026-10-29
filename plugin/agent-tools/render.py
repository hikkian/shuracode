#!/usr/bin/env python3
"""ShuraCode agent tool `render` (AGTOOLS1): open an HTML file or a URL in headless Chromium (the Playwright that shura-qa installed,
offline) at a given viewport width, take a screenshot and measure the page: horizontal overflow, elements sticking out of the viewport,
the smallest text, the lowest text contrast, buttons and links shorter than 44 px, headings and images without alt, console errors,
and (on request) how many A4 pages the page prints to. Reads a JSON spec on stdin, prints one JSON line.

    echo '{"file": "/abs/index.html", "width": 390, "png": "/tmp/shot.png", "pdf": false}' | python -I render.py

Spec: file (path) or url; width (320–1920, default 1280); full_page (default true, the screenshot is capped at 2400 px high);
png (where to write the screenshot; omitted = no screenshot); pdf (A4 page count with 12 mm margins); timeout_ms (default 15000).
Output: {"ok", "metrics": {...}, "problems": [...], "png": path, "pdf_pages": n, "error": ...}. Standard library + Playwright only.
"""
import json
import re
import sys

JS = r'''(args) => {
  const [vw] = args;
  const lum = (r,g,b) => { const f = v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const parse = s => { const m = s && s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(x=>parseFloat(x)); return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}; };
  const bgOf = el => { let e = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; e = e.parentElement; } return {r:255,g:255,b:255,a:1}; };
  const label = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0,2).join('.') : '') + ' "' + el.textContent.trim().slice(0, 40).replace(/\s+/g, ' ') + '"';
  let minFont = 1e9, minFontEl = '', minContrast = 1e9, worst = '', textNodes = 0;
  const outside = [];
  for (const el of document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,a,button,span,td,th,label,small,strong,em,div,dt,dd,figcaption,blockquote,code,pre")) {
    const direct = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!direct) continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    textNodes++;
    if (r.right > vw + 1 && outside.length < 5) outside.push(label(el) + ' reaches x=' + Math.round(r.right));
    const fs = parseFloat(cs.fontSize); if (fs < minFont) { minFont = fs; minFontEl = label(el); }
    const fg = parse(cs.color), bg = bgOf(el);
    if (fg && fg.a > 0.5) { const l1 = lum(fg.r,fg.g,fg.b), l2 = lum(bg.r,bg.g,bg.b); const c = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
      if (c < minContrast) { minContrast = c; worst = label(el); } }
  }
  const small = [], controls = [];
  for (const el of document.querySelectorAll("button,a,input[type=button],input[type=submit],[role=button]")) {
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    if (controls.length < 8) controls.push(label(el) + ': ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px');
    if (r.height < 44 && small.length < 5) small.push(label(el) + ' is ' + Math.round(r.height) + 'px tall');
  }
  // invisible controls: a button or link with no size (display:none, empty, collapsed) is as bad as a missing one
  const hidden = [];
  for (const el of document.querySelectorAll("button,a[href],[role=button]")) {
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) { if (hidden.length < 5) hidden.push(label(el)); }
  }
  const count = s => { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
  return {scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, innerWidth: window.innerWidth,
          title: document.title, textNodes, minFont: minFont === 1e9 ? null : minFont, minFontEl, minContrast: minContrast === 1e9 ? null : Math.round(minContrast * 100) / 100, worst,
          outside, smallControls: small, controls, hiddenControls: hidden, h1: count('h1'), h2: count('h2'), buttons: count('button, a.button, .button, [role=button]'), links: count('a[href]'),
          imgNoAlt: count('img:not([alt])'), images: count('img'), lang: document.documentElement.lang || '', viewportMeta: !!document.querySelector('meta[name=viewport]')};
}'''


def main():
    spec = json.loads(sys.stdin.read() or "{}")
    width = max(320, min(1920, int(spec.get("width") or 1280)))
    height = 900 if width >= 1000 else 844
    out = {"ok": False, "width": width}
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        out["error"] = f"Playwright is not available to this Python: {e}"
        print(json.dumps(out))
        return
    target = spec.get("url") or ("file://" + spec["file"])
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": width, "height": height})
            page.on("pageerror", lambda err: errors.append(f"page error: {str(err)[:160]}"))
            page.on("console", lambda msg: errors.append(f"console.{msg.type}: {msg.text[:160]}") if msg.type == "error" else None)
            page.goto(target, wait_until="load", timeout=int(spec.get("timeout_ms") or 15000))
            page.wait_for_timeout(200)
            m = page.evaluate(JS, [width])
            out["metrics"] = m
            problems = []
            if m["scrollWidth"] > m["innerWidth"]:
                problems.append(f"horizontal overflow: the page is {m['scrollWidth']}px wide in a {m['innerWidth']}px viewport (horizontal scrollbar)")
            for x in m["outside"]:
                problems.append(f"sticks out of the viewport: {x}")
            if m["minFont"] is not None and m["minFont"] < 14:
                problems.append(f"smallest text {round(m['minFont'], 1)}px at {m['minFontEl']} (keep body text >= 14px, fine print >= 12px)")
            if m["minContrast"] is not None and m["minContrast"] < 4.5:
                problems.append(f"lowest text contrast {m['minContrast']}:1 at {m['worst']} (WCAG wants >= 4.5:1)")
            for x in m["smallControls"]:
                problems.append(f"small tap target: {x} (aim for >= 44px)")
            for x in m["hiddenControls"]:
                problems.append(f"invisible control (no size on screen): {x}")
            if not m["controls"]:
                problems.append("no visible button or link at all: a call to action must be a visible <button>, <a href> or role=button")
            if m["h1"] != 1:
                problems.append(f"{m['h1']} <h1> elements (a page wants exactly one)")
            if m["imgNoAlt"] > 0:
                problems.append(f"{m['imgNoAlt']} image(s) without alt text")
            if not m["viewportMeta"] and width < 1000:
                problems.append("no <meta name=viewport>: phones will zoom the page out")
            if m["textNodes"] == 0:
                problems.append("no visible text at all")
            problems += errors[:5]
            out["problems"] = problems
            if spec.get("png"):
                full = spec.get("full_page", True)
                if full and m["scrollHeight"] > 2400:
                    page.set_viewport_size({"width": width, "height": 2400})
                    page.screenshot(path=spec["png"], full_page=False)
                    out["screenshot_note"] = f"page is {m['scrollHeight']}px tall; the screenshot shows the first 2400px"
                else:
                    page.screenshot(path=spec["png"], full_page=bool(full))
                out["png"] = spec["png"]
            if spec.get("pdf"):
                pdf = page.pdf(format="A4", print_background=True, margin={"top": "12mm", "bottom": "12mm", "left": "12mm", "right": "12mm"})
                out["pdf_pages"] = len(re.findall(rb"/Type\s*/Page\b", pdf))
                if out["pdf_pages"] != 1:
                    out["problems"].append(f"prints to {out['pdf_pages']} A4 pages")
            browser.close()
        out["ok"] = True
    except Exception as e:  # noqa: BLE001 — the tool reports the failure as text, it never raises into the engine
        out["error"] = str(e)[:400]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
