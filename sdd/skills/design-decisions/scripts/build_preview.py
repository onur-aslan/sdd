#!/usr/bin/env python3
"""design-decisions helper (Python 3, stdlib only).

  build_preview.py build <choices.json> [-o OUT] [--only D03,D05] [--design-md DESIGN.md]
      choices.json + assets/choose-template.html -> self-contained HTML preview.
      --only renders just those decisions (for re-asking unanswered ones).
      Output names follow the choices file: choices-k2-chat.json ->
      .design/choose-k2-chat.html (choices-k1.json -> choose-k1.html).
      Layer 2: tokens are read from the Tokens block of DESIGN.md when 'tokens' is empty.

  build_preview.py serve <choices.json> [-o OUT] [--only ...] [--design-md ...]
                          [--port N] [--timeout SECONDS] [--no-open]
      Same as build, then serves the preview on 127.0.0.1 and waits for its
      'Send selections' button. Writes <choices>.selections.txt (-partial with
      --only), prints it and exits, so the caller never copy-pastes a block.
      Exit code 3 when no selections arrive before --timeout (default 1800s).

  build_preview.py check <choices.json> <selections-file | -> [--fresh] [--no-save]
      Validates the pasted selections block and merges the answers into
      <choices>.resolved.json, so partial rounds accumulate. Prints JSON:
      ok, missing (across ALL decisions), problems, resolved, tokens.
      Exit code 2 when not ok.

Exit code 1: invalid input (schema errors, unreadable files).
"""
import argparse
import hashlib
import http.server
import json
import re
import secrets
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE.parent / "assets" / "choose-template.html"
PLACEHOLDER = "__CHOICES_JSON__"
FORBIDDEN_KEYS = {"selected", "default", "recommended", "preselected", "checked", "preferred"}
STEERING = re.compile(
    r"\b(recommended?|popular|best|ideal|perfect|modern|sleek|clean)\b",
    re.IGNORECASE,
)
# Template defaults for preview variables (used when computing contrast).
DEFAULTS = {"--bg": "#ffffff", "--surface": "#f4f4f5", "--text": "#18181b",
            "--muted": "#52525b", "--primary": "#2563eb", "--on-primary": "#ffffff"}
CONTRAST_PAIRS = [("--text", "--bg"), ("--on-primary", "--primary"), ("--primary", "--bg"),
                  ("--muted", "--bg"), ("--text", "--surface")]


# ---------------------------------------------------------------- helpers
def fail(msg):
    print("error:", msg, file=sys.stderr)
    sys.exit(1)


def load(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except FileNotFoundError:
        fail(f"file not found: {path}")
    except json.JSONDecodeError as e:
        fail(f"{path} is not valid JSON: {e}")


def round_label(choices, layer):
    """choices-k2-chat.json -> 'k2-chat'; other names fall back to 'k<layer>'."""
    stem = Path(choices).stem
    prefix = "choices-"
    if stem.startswith(prefix) and len(stem) > len(prefix):
        return stem[len(prefix):]
    return f"k{layer}"


def hex_rgb(v):
    m = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", str(v).strip())
    if not m:
        return None
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def luminance(rgb):
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (f(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def contrast_warnings(label, vars_):
    out = []
    for fg, bg in CONTRAST_PAIRS:
        if fg not in vars_ and bg not in vars_:
            continue  # nothing this alternative defines is involved
        a = hex_rgb(vars_.get(fg, DEFAULTS.get(fg, "")))
        b = hex_rgb(vars_.get(bg, DEFAULTS.get(bg, "")))
        if a and b:
            ratio = contrast(a, b)
            if ratio < 4.5:
                out.append(f"{label}: contrast {fg} on {bg} is {ratio:.2f}:1 (< 4.5:1 baseline)")
    return out


def tokens_from_design_md(path):
    """Read CSS variables from the ```css :root {...}``` block under '## Tokens'."""
    p = Path(path)
    if not p.is_file():
        return {}
    text = p.read_text(encoding="utf-8-sig")
    sec = re.search(r"^##\s+Tokens\b(.*?)(?=^##\s|\Z)", text, re.S | re.M)
    if not sec:
        return {}
    blk = re.search(r":root\s*\{(.*?)\}", sec.group(1), re.S)
    if not blk:
        return {}
    out = {}
    for name, val in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", blk.group(1)):
        val = val.strip()
        if val and val != "...":
            out[name] = val
    return out


# ------------------------------------------------------------- validation
def validate(data):
    errors, warnings = [], []
    if not isinstance(data, dict):
        return ["top level must be a JSON object"], warnings
    if not isinstance(data.get("project"), str) or not data["project"].strip():
        errors.append("project: required non-empty string")
    if data.get("layer") not in (1, 2):
        errors.append("layer: must be 1 or 2")
    if "fonts" in data:
        errors.append("'fonts' (web fonts) is not supported; previews must render offline")
    if not data.get("sample"):
        warnings.append("no 'sample': previews fall back to generic text instead of the project's real content")
    tokens = data.get("tokens", {})
    if not isinstance(tokens, dict):
        errors.append("tokens: must be an object of CSS variables")
        tokens = {}
    decisions = data.get("decisions")
    if not isinstance(decisions, list) or not decisions:
        errors.append("decisions: required non-empty list")
        return errors, warnings

    seen = set()
    for d in decisions:
        if not isinstance(d, dict):
            errors.append("decisions: every entry must be an object")
            continue
        did = str(d.get("id", "?"))
        if not re.fullmatch(r"D\d+", did):
            errors.append(f"{did}: id must look like D01")
        if did in seen:
            errors.append(f"{did}: duplicate decision id")
        seen.add(did)
        if not d.get("title"):
            errors.append(f"{did}: title required")
        alts = d.get("alternatives")
        if not isinstance(alts, list):
            errors.append(f"{did}: alternatives must be a list")
            continue
        ids, real = set(), 0
        for a in alts:
            if not isinstance(a, dict):
                errors.append(f"{did}: every alternative must be an object")
                continue
            aid = str(a.get("id", ""))
            label = f"{did}/{aid}"
            if not re.fullmatch(r"[A-Z0-9]{1,6}", aid):
                errors.append(f"{did}: alternative id '{aid}' must be uppercase letters/digits")
            if aid == "OTHER":
                errors.append(f"{did}: 'OTHER' is reserved (the template adds it)")
            if aid in ids:
                errors.append(f"{label}: duplicate alternative id")
            ids.add(aid)
            if not a.get("name"):
                errors.append(f"{label}: name required")
            vars_ = a.get("vars", {})
            if not isinstance(vars_, dict):
                errors.append(f"{label}: vars must be an object")
                vars_ = {}
            if aid != "KEEP":
                real += 1
            elif not vars_ and not a.get("html") and (a.get("preview") or d.get("preview") or "components") != "none":
                warnings.append(f"{label}: no vars/html, so it previews with neutral defaults, not the project's current style")
            bad = FORBIDDEN_KEYS & set(a)
            if bad:
                errors.append(f"{label}: forbidden key(s) {sorted(bad)} (nothing may be preselected or promoted)")
            if "fonts" in a:
                errors.append(f"{label}: 'fonts' (web fonts) is not supported; use system font stacks in vars")
            if re.search(r"https?://|@import|url\(", json.dumps(a)):
                warnings.append(f"{label}: external resource (URL/@import) found; previews must work offline")
            for field in ("name", "desc"):
                m = STEERING.search(str(a.get(field, "")))
                if m:
                    warnings.append(f"{label}.{field}: steering/value-laden word '{m.group(0)}'")
            warnings.extend(contrast_warnings(label, {**tokens, **vars_}))
        if real < 3:
            errors.append(f"{did}: needs at least 3 alternatives (excluding KEEP), found {real}")
    return errors, warnings


# ------------------------------------------------------------------ build
def do_build(args, quiet=False):
    """Validate and render the preview. Returns (data, output path)."""
    data = load(args.choices)
    if isinstance(data, dict) and data.get("layer") == 2 and not data.get("tokens"):
        toks = tokens_from_design_md(args.design_md)
        if toks:
            data["tokens"] = toks
            print(f"note: {len(toks)} tokens read from {args.design_md}", file=sys.stderr)
        else:
            print(f"warning: layer 2 without tokens and none found in {args.design_md}; "
                  "previews won't use the locked Layer 1 style", file=sys.stderr)
    errors, warnings = validate(data)
    for w in warnings:
        print("warning:", w, file=sys.stderr)
    if errors:
        for e in errors:
            print("error:", e, file=sys.stderr)
        sys.exit(1)
    if args.only:
        wanted = [x.strip() for x in args.only.split(",") if x.strip()]
        known = {d["id"] for d in data["decisions"]}
        unknown = [x for x in wanted if x not in known]
        if unknown:
            fail(f"--only: unknown decision id(s) {unknown}")
        data["decisions"] = [d for d in data["decisions"] if d["id"] in wanted]
    template = Path(args.template or TEMPLATE).read_text(encoding="utf-8")
    if PLACEHOLDER not in template:
        fail(f"template has no {PLACEHOLDER} placeholder")
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    suffix = "-partial" if args.only else ""
    out = Path(args.output or f".design/choose-{round_label(args.choices, data['layer'])}{suffix}.html")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(template.replace(PLACEHOLDER, payload), encoding="utf-8")
    if not quiet:
        print(out)
    return data, out


def cmd_build(args):
    do_build(args)
    return 0


# ------------------------------------------------------------------- serve
def selections_path(choices, only):
    p = Path(choices).with_suffix(".selections.txt")
    return p.with_name(p.stem + "-partial" + p.suffix) if only else p


def cmd_serve(args):
    data, out = do_build(args, quiet=True)
    html = out.read_bytes()
    target = selections_path(args.choices, args.only)
    token = secrets.token_urlsafe(18)
    state = {"posted": None, "timed_out": False}
    lock = threading.Lock()

    class Handler(http.server.BaseHTTPRequestHandler):
        """Serves one preview and accepts one selections POST."""

        server_version = "design-decisions"
        origins = set()

        def log_message(self, *a):
            pass

        def reply(self, code, body=b"", ctype="text/plain; charset=utf-8"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            # The random token in the path keeps other local pages out.
            if urllib.parse.urlsplit(self.path).path.rstrip("/") == "/" + token:
                self.reply(200, html, "text/html; charset=utf-8")
            else:
                self.reply(404, b"design-decisions: open the URL printed in the terminal\n")

        def do_POST(self):
            if urllib.parse.urlsplit(self.path).path != "/" + token + "/submit":
                self.reply(404, b"not found\n")
                return
            origin = self.headers.get("Origin", "")
            if origin and origin not in self.origins:
                self.reply(403, b"bad origin\n")
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            try:
                text = self.rfile.read(length).decode("utf-8") if length else ""
            except UnicodeDecodeError:
                self.reply(400, b"body is not utf-8\n")
                return
            if not text.lstrip().startswith("DESIGN-SELECTIONS"):
                self.reply(400, b"body is not a DESIGN-SELECTIONS block\n")
                return
            with lock:
                if state["posted"] is not None:
                    self.reply(409, b"selections already received\n")
                    return
                state["posted"] = text
            self.reply(200, b"ok\n")
            threading.Thread(target=server.shutdown, daemon=True).start()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    Handler.origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    url = f"http://127.0.0.1:{port}/{token}/"

    def on_timeout():
        state["timed_out"] = True
        server.shutdown()

    timer = threading.Timer(max(1, args.timeout), on_timeout)
    timer.daemon = True
    timer.start()
    print(url, flush=True)
    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        timer.cancel()
        server.server_close()

    if state["posted"] is None:
        why = "timed out" if state["timed_out"] else "stopped"
        print(f"error: no selections received ({why})", file=sys.stderr)
        return 3
    target.write_text(state["posted"], encoding="utf-8")
    print(target)
    print(state["posted"])
    return 0


# ------------------------------------------------------------------ check
def parse_selections(text):
    header, rows = None, {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("DESIGN-SELECTIONS"):
            header = dict(re.findall(r"(\w+)=(\S+)", line))
            continue
        m = re.match(r"^(D\d+):\s*(.*)$", line)
        if not m:
            continue
        rest, note = m.group(2), ""
        if " | note:" in rest:
            rest, note = rest.split(" | note:", 1)
        rows[m.group(1)] = (rest.strip(), note.strip())
    return header, rows


def decision_fingerprint(entry):
    """Stable hash of the chosen design values, used by the delta manifest."""
    c = entry.get("choice") or {}
    if c.get("id") == "OTHER":
        payload = {"id": entry["id"], "choice": "OTHER", "desc": c.get("desc", "")}
    else:
        payload = {"id": entry["id"], "choice": c.get("id"), "values": c.get("values", ""),
                   "vars": c.get("vars", {}), "html": c.get("html", "")}
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def cmd_check(args):
    data = load(args.choices)
    errors, _ = validate(data)
    if errors:
        for e in errors:
            print("error:", e, file=sys.stderr)
        return 1
    try:
        text = sys.stdin.read() if args.selections == "-" else Path(args.selections).read_text(encoding="utf-8-sig")
    except OSError as e:
        fail(f"cannot read selections: {e}")
    header, rows = parse_selections(text)
    problems = []
    if header is None:
        problems.append("missing DESIGN-SELECTIONS header line")
    else:
        if header.get("project") != data["project"]:
            problems.append(f"project mismatch: block says '{header.get('project')}', choices says '{data['project']}'")
        if str(header.get("layer")) != str(data["layer"]):
            problems.append(f"layer mismatch: block says '{header.get('layer')}', choices says '{data['layer']}'")

    state_path = Path(args.choices).with_suffix(".resolved.json")
    prior = {}
    if state_path.is_file() and not args.fresh:
        try:
            prior = {e["id"]: e for e in json.loads(state_path.read_text(encoding="utf-8-sig"))}
        except (json.JSONDecodeError, KeyError, TypeError):
            problems.append(f"{state_path.name} is unreadable and was ignored")

    known = {d["id"] for d in data["decisions"]}
    for did in rows:
        if did not in known:
            problems.append(f"{did}: not in {Path(args.choices).name}")

    merged, missing = {}, []
    for d in data["decisions"]:
        did = d["id"]
        alts = {a["id"]: a for a in d["alternatives"]}
        entry = None
        # an earlier answer survives only if its alternative still has the same name
        old = prior.get(did)
        if old:
            oc = old.get("choice", {})
            if oc.get("id") == "OTHER" or (oc.get("id") in alts and alts[oc["id"]]["name"] == oc.get("name")):
                entry = old
        val, note = rows.get(did, ("—", ""))
        if val not in ("—", "-", ""):
            m = re.match(r"^([A-Za-z0-9_-]+)(?:\s*\((.*)\))?$", val, re.DOTALL)
            if not m:
                problems.append(f"{did}: cannot parse '{val}'")
            else:
                cid, extra = m.group(1).upper(), (m.group(2) or "").strip()
                if cid == "OTHER":
                    if not extra:
                        problems.append(f"{did}: OTHER without a description")
                    else:
                        choice = {"id": "OTHER", "name": "Other", "desc": extra, "custom": True}
                        entry = None
                elif cid in alts:
                    a = alts[cid]
                    choice = {k: a[k] for k in ("id", "name", "desc", "values", "vars", "html") if a.get(k)}
                    if cid == "KEEP":
                        choice["unchanged"] = True
                else:
                    problems.append(f"{did}: unknown alternative '{cid}'")
                    choice = None
                if (cid == "OTHER" and extra) or (cid in alts):
                    entry = {
                        "id": did,
                        "title": d["title"],
                        "scope": d.get("scope", "global" if data["layer"] == 1 else ""),
                        "choice": choice,
                        "rejected": [{"id": a["id"], "name": a["name"]} for a in d["alternatives"]
                                     if a["id"] not in (cid, "KEEP")],
                        "note": note,
                    }
        if entry is None:
            missing.append(did)
        else:
            merged[did] = entry

    resolved = [merged[d["id"]] for d in data["decisions"] if d["id"] in merged]
    for e in resolved:
        e["fingerprint"] = decision_fingerprint(e)
    tokens = {}
    for e in resolved:
        tokens.update(e["choice"].get("vars", {}))
    if not args.no_save:
        state_path.write_text(json.dumps(resolved, ensure_ascii=False, indent=1), encoding="utf-8")
    ok = not missing and not problems
    json.dump({"ok": ok, "missing": missing, "problems": problems, "resolved": resolved, "tokens": tokens},
              sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0 if ok else 2


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("choices")
    b.add_argument("-o", "--output")
    b.add_argument("--only", help="comma-separated decision ids to render, e.g. D03,D05")
    b.add_argument("--design-md", default="DESIGN.md", help="where Layer 2 reads locked tokens from")
    b.add_argument("--template")
    b.set_defaults(fn=cmd_build)
    s = sub.add_parser("serve")
    s.add_argument("choices")
    s.add_argument("-o", "--output")
    s.add_argument("--only", help="comma-separated decision ids to render, e.g. D03,D05")
    s.add_argument("--design-md", default="DESIGN.md", help="where Layer 2 reads locked tokens from")
    s.add_argument("--template")
    s.add_argument("--port", type=int, default=0, help="loopback port (0 = pick a free one)")
    s.add_argument("--timeout", type=int, default=1800,
                   help="seconds to wait for the selections (default 1800)")
    s.add_argument("--no-open", action="store_true", help="don't open the browser")
    s.set_defaults(fn=cmd_serve)
    c = sub.add_parser("check")
    c.add_argument("choices")
    c.add_argument("selections")
    c.add_argument("--fresh", action="store_true", help="ignore earlier answers in <choices>.resolved.json")
    c.add_argument("--no-save", action="store_true", help="don't write <choices>.resolved.json")
    c.set_defaults(fn=cmd_check)
    args = ap.parse_args()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    main()
