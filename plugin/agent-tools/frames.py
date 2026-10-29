#!/usr/bin/env python3
"""ShuraCode agent tool `frames` (AGTOOLS1): a video (or audio) file becomes an ffprobe summary and 3–6 PNG frames at chosen times,
scaled to a given width, so that the agent can look at what it cut or rendered. Standard library + ffmpeg/ffprobe; Pillow (if the
Python has it) adds a brightness figure per frame for the text-only case.

    echo '{"file": "/abs/out.mp4", "times": [0.5, 2.0], "count": 4, "width": 480, "dir": "/tmp/frames"}' | python3 -I frames.py

Output: {"ok", "probe": {...}, "frames": [{"time", "png", "width", "height", "brightness"}], "problems": [...], "error"}.
"""
import json
import os
import subprocess
import sys


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", path], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-300:] or "ffprobe failed")
    info = json.loads(r.stdout)
    fmt = info.get("format", {})
    streams = []
    for s in info.get("streams", []):
        d = {"type": s.get("codec_type"), "codec": s.get("codec_name")}
        if s.get("codec_type") == "video":
            d.update({"width": s.get("width"), "height": s.get("height"), "fps": s.get("r_frame_rate"), "frames": s.get("nb_frames")})
        if s.get("codec_type") == "audio":
            d.update({"sample_rate": s.get("sample_rate"), "channels": s.get("channels")})
        streams.append(d)
    return {"duration": round(float(fmt.get("duration") or 0), 3), "size_bytes": int(fmt.get("size") or 0), "container": fmt.get("format_name"),
            "streams": streams}


def brightness(png):
    try:
        from PIL import Image, ImageStat
        return round(ImageStat.Stat(Image.open(png).convert("L")).mean[0])
    except Exception:  # noqa: BLE001 — Pillow is optional
        return None


def main():
    spec = json.loads(sys.stdin.read() or "{}")
    out = {"ok": False, "problems": []}
    try:
        path = spec["file"]
        info = probe(path)
        out["probe"] = info
        video = [s for s in info["streams"] if s["type"] == "video"]
        if not video:
            out["problems"].append("no video stream: nothing to show as frames")
            out["frames"] = []
            out["ok"] = True
            print(json.dumps(out, ensure_ascii=False))
            return
        dur = info["duration"]
        times = spec.get("times")
        if not times:
            n = max(1, min(6, int(spec.get("count") or 4)))
            span = max(dur - 0.2, 0.0)
            times = [round(0.1 + span * (i + 0.5) / n, 2) for i in range(n)] if dur > 0 else [0.0]
        times = [max(0.0, min(float(t), max(dur - 0.05, 0.0))) for t in times][:6]
        width = max(160, min(960, int(spec.get("width") or 480)))
        d = spec.get("dir") or os.getcwd()
        os.makedirs(d, exist_ok=True)
        stem = os.path.splitext(os.path.basename(path))[0]
        frames = []
        for t in times:
            png = os.path.join(d, f"{stem}-{t:.2f}s.png")
            r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", "-vf", f"scale='min({width},iw)':-2", png],
                               capture_output=True, text=True, timeout=120)
            if r.returncode != 0 or not os.path.isfile(png):
                out["problems"].append(f"no frame at {t:.2f} s: {r.stderr.strip()[-120:]}")
                continue
            w = h = None
            try:
                from PIL import Image
                with Image.open(png) as im:
                    w, h = im.size
            except Exception:  # noqa: BLE001
                pass
            frames.append({"time": round(t, 2), "png": png, "width": w, "height": h, "brightness": brightness(png)})
        out["frames"] = frames
        if frames and all(f["brightness"] is not None and f["brightness"] < 8 for f in frames):
            out["problems"].append("every sampled frame is almost black")
        out["ok"] = True
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)[:400]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
