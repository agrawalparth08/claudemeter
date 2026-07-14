#!/usr/bin/env python3
"""
claudemeter ETL: parse local Claude transcripts into a pre-aggregated data.json
for the dashboard. Pure Python standard library, no dependencies.

Two transcript trees are scanned by default:

1. ~/.claude/projects/**/*.jsonl (+ subagents/*.jsonl): Claude Code from the
   terminal, Claude Code inside the Desktop app, and programmatic Agent-SDK apps
   (distinguished by "entrypoint": "cli" / "claude-desktop" / "sdk-cli").
2. ~/Library/Application Support/Claude/local-agent-mode-sessions/**/.claude/projects/**/*.jsonl
   Claude Cowork tasks. Each runs Claude Code inside its own sandboxed VM whose
   transcripts mirror to disk, tagged entrypoint "local-agent". Session titles for
   Cowork and Desktop live in sibling local_<uuid>.json metadata files.

Pure claude.ai web chat is NOT logged locally and cannot be included.

Usage:
    python3 etl.py                     # scan the default macOS/Linux locations
    python3 etl.py --out data.json     # choose output path
    python3 etl.py --tz America/New_York
    python3 etl.py --root /some/dir    # scan custom root(s) instead of defaults (repeatable)

This logic is mirrored 1:1 in etl.js; test/parity.mjs enforces they never drift.
"""
import argparse
import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo

HOME = os.path.expanduser("~")
DEFAULT_ROOTS = [
    os.path.join(HOME, ".claude", "projects"),
    os.path.join(HOME, "Library", "Application Support", "Claude", "local-agent-mode-sessions"),
    os.path.join(HOME, "Library", "Application Support", "Claude", "claude-code-sessions"),
]

# $/1M tokens: (input, output). Cache write = input * 1.25 (5m) / *2 (1h). Cache read = input * 0.1
PRICING = {
    "claude-fable-5":     {"input": 10.00, "output": 50.00},
    "claude-mythos-5":    {"input": 10.00, "output": 50.00},
    "claude-opus-4-8":    {"input": 5.00,  "output": 25.00},
    "claude-opus-4-7":    {"input": 5.00,  "output": 25.00},
    "claude-opus-4-6":    {"input": 5.00,  "output": 25.00},
    "claude-opus-4-5":    {"input": 5.00,  "output": 25.00},  # legacy, aligned to opus tier
    "claude-opus-4-1":    {"input": 5.00,  "output": 25.00},
    "claude-opus-4-0":    {"input": 5.00,  "output": 25.00},
    "claude-sonnet-4-6":  {"input": 3.00,  "output": 15.00},
    "claude-sonnet-4-5":  {"input": 3.00,  "output": 15.00},
    "claude-sonnet-4-0":  {"input": 3.00,  "output": 15.00},
    "claude-haiku-4-5":   {"input": 1.00,  "output": 5.00},
}
# claude-sonnet-5 has time-gated introductory pricing (intro through 2026-08-31)
SONNET5_INTRO_CUTOVER = "2026-08-31"
SONNET5_INTRO = {"input": 2.00, "output": 10.00}
SONNET5_STANDARD = {"input": 3.00, "output": 15.00}

ENTRYPOINT_LABELS = {
    "cli": "Claude Code (terminal)",
    "claude-desktop": "Claude Code (Desktop)",
    "sdk-cli": "Programmatic (Agent SDK apps)",
    "local-agent": "Claude Cowork",
}


def local_tz_name():
    """Best-effort IANA name of the system timezone, so the CLI defaults to the
    same local zone the browser build uses (instead of a hardcoded value).
    Reads the /etc/localtime symlink (macOS/Linux); falls back to UTC."""
    try:
        target = os.path.realpath("/etc/localtime")
        if "zoneinfo/" in target:
            name = target.split("zoneinfo/")[-1]
            ZoneInfo(name)  # validate
            return name
    except Exception:
        pass
    return os.environ.get("CLAUDEMETER_TZ") or "UTC"


def normalize_model(model):
    if not model:
        return "unknown"
    m = model
    if "[" in m:                        # strip suffixes like [1m]
        m = m.split("[")[0]
    if m.startswith("claude-haiku-4-5"):  # dated snapshot -> canonical alias
        m = "claude-haiku-4-5"
    return m


def get_pricing(model, date_str):
    if model == "claude-sonnet-5":
        if date_str and date_str < SONNET5_INTRO_CUTOVER:
            return SONNET5_INTRO
        return SONNET5_STANDARD
    return PRICING.get(model, {"input": None, "output": None})


def compute_cost(model, date_str, usage):
    p = get_pricing(model, date_str)
    if p["input"] is None:
        return None  # unknown model pricing
    input_tok = usage.get("input_tokens", 0) or 0
    output_tok = usage.get("output_tokens", 0) or 0
    cache_read = usage.get("cache_read_input_tokens", 0) or 0
    cache_creation = usage.get("cache_creation_input_tokens", 0) or 0
    cc = usage.get("cache_creation") or {}
    cc_5m = cc.get("ephemeral_5m_input_tokens", 0) or 0
    cc_1h = cc.get("ephemeral_1h_input_tokens", 0) or 0
    # empty breakdown but non-zero cache-creation -> treat it all as 5m
    if (cc_5m + cc_1h) == 0 and cache_creation > 0:
        cc_5m = cache_creation

    per_m = 1_000_000
    ip = p["input"]
    op = p["output"]
    cost = (
        input_tok * ip
        + output_tok * op
        + cc_5m * ip * 1.25
        + cc_1h * ip * 2.0
        + cache_read * ip * 0.1
    ) / per_m
    return {
        "cost": cost,
        "input_tokens": input_tok,
        "output_tokens": output_tok,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cc_5m + cc_1h,
        "total_tokens": input_tok + output_tok + cache_read + cc_5m + cc_1h,
    }


def label_surface(entrypoint):
    return ENTRYPOINT_LABELS.get(entrypoint) or "Other / unknown"


def classify_path(path):
    """(kind, is_cowork, project) for a file path. Mirrors etl.js classifyPath."""
    base = os.path.basename(path)
    norm = path.replace(os.sep, "/")
    if base == "audit.jsonl":
        return ("skip", False, None)
    if base.endswith(".jsonl"):
        is_cowork = "local-agent-mode-sessions" in norm
        project = None
        # local_<uuid> segment for cowork
        import re
        m = re.search(r"local_[0-9a-f-]{6,}", norm)
        if is_cowork and m:
            project = m.group(0)
        else:
            after = norm.split("/projects/", 1)
            if len(after) > 1:
                project = after[1].split("/")[0]
            else:
                project = norm.split("/")[0] or "root"
        return ("transcript", is_cowork, project)
    if base.startswith("local_") and base.endswith(".json"):
        return ("title", False, None)
    return ("skip", False, None)


def scan_roots(roots):
    """Walk roots; return (transcripts sorted by path, titles map). os.walk
    descends into dot-directories (e.g. .claude), which glob silently skips."""
    transcripts = []   # (path, project, is_cowork)
    title_files = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, filenames in os.walk(root):
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                kind, is_cowork, project = classify_path(fp)
                if kind == "transcript":
                    transcripts.append((fp, project, is_cowork))
                elif kind == "title":
                    title_files.append(fp)

    titles = {}
    for fp in title_files:
        try:
            with open(fp) as f:
                d = json.load(f)
        except Exception:
            continue
        csid = d.get("cliSessionId")
        if csid:
            titles[csid] = {
                "title": d.get("title"),
                "processName": d.get("processName") or d.get("vmProcessName"),
            }

    transcripts.sort(key=lambda t: t[0])  # deterministic order (parity + stable output)
    return transcripts, titles


def percentile(sorted_asc, p):
    if not sorted_asc:
        return 0
    idx = min(len(sorted_asc) - 1, int(p * len(sorted_asc)))
    return sorted_asc[idx]


def build(roots, tz_name):
    tz = ZoneInfo(tz_name)
    transcripts, titles = scan_roots(roots)
    n_cowork = sum(1 for _, _, cw in transcripts if cw)
    print(f"Found {len(transcripts)} transcript files ({n_cowork} from Cowork tasks), "
          f"{len(titles)} session titles")

    by_day, by_model, by_surface, by_session = {}, {}, {}, {}
    surface_sessions = {}   # surface -> set(sessionId), for an accurate per-surface session count
    unknown_models = {}
    total_messages = parsed_messages = 0
    earliest = latest = None
    dup_line_count = dup_groups_count = 0

    for fp, project, is_cowork in transcripts:
        try:
            per_request = {}  # per-file dedup by requestId (last-seen wins)
            with open(fp, "r", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get("type") != "assistant":
                        continue
                    msg = d.get("message") or {}
                    if not msg.get("usage"):
                        continue
                    if msg.get("model") == "<synthetic>":
                        continue
                    key = d.get("requestId") or (msg.get("id") and f"mid:{msg['id']}") or d.get("uuid")
                    if key in per_request:
                        dup_line_count += 1
                    else:
                        dup_groups_count += 1
                    per_request[key] = d

            for d in per_request.values():
                msg = d.get("message") or {}
                usage = msg.get("usage")
                total_messages += 1
                model = normalize_model(msg.get("model"))
                ts = d.get("timestamp")
                if not ts:
                    continue
                try:
                    dt_local = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(tz)
                except Exception:
                    continue
                day = dt_local.strftime("%Y-%m-%d")
                if earliest is None or ts < earliest:
                    earliest = ts
                if latest is None or ts > latest:
                    latest = ts

                result = compute_cost(model, day, usage)
                if result is None:
                    unknown_models[model] = unknown_models.get(model, 0) + 1
                    continue
                parsed_messages += 1

                surface = "Claude Cowork" if is_cowork else label_surface(d.get("entrypoint"))
                sid = d.get("sessionId")

                db = by_day.setdefault(day, {"cost": 0.0, "tokens": 0, "count": 0, "by_model": {}, "by_surface": {}})
                db["cost"] += result["cost"]; db["tokens"] += result["total_tokens"]; db["count"] += 1
                dm = db["by_model"].setdefault(model, {"cost": 0.0, "tokens": 0, "count": 0})
                dm["cost"] += result["cost"]; dm["tokens"] += result["total_tokens"]; dm["count"] += 1
                dss = db["by_surface"].setdefault(surface, {"cost": 0.0, "tokens": 0, "count": 0})
                dss["cost"] += result["cost"]; dss["tokens"] += result["total_tokens"]; dss["count"] += 1

                mm = by_model.setdefault(model, {"cost": 0.0, "tokens": 0, "count": 0, "input_tokens": 0,
                                                 "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0})
                mm["cost"] += result["cost"]; mm["tokens"] += result["total_tokens"]; mm["count"] += 1
                mm["input_tokens"] += result["input_tokens"]; mm["output_tokens"] += result["output_tokens"]
                mm["cache_read_tokens"] += result["cache_read_tokens"]; mm["cache_write_tokens"] += result["cache_write_tokens"]

                sm = by_surface.setdefault(surface, {"cost": 0.0, "tokens": 0, "count": 0})
                sm["cost"] += result["cost"]; sm["tokens"] += result["total_tokens"]; sm["count"] += 1

                if sid:
                    surface_sessions.setdefault(surface, set()).add(sid)
                    ss = by_session.setdefault(sid, {"cost": 0.0, "tokens": 0, "count": 0, "models": {},
                                                     "surface": surface, "project": project, "first_ts": ts, "last_ts": ts})
                    ss["cost"] += result["cost"]; ss["tokens"] += result["total_tokens"]; ss["count"] += 1
                    ss["models"][model] = ss["models"].get(model, 0) + 1
                    if ts < ss["first_ts"]:
                        ss["first_ts"] = ts
                    if ts > ss["last_ts"]:
                        ss["last_ts"] = ts
        except Exception as e:
            print(f"ERROR reading {fp}: {e}")

    session_list = []
    for sid, s in by_session.items():
        session_list.append({
            "sessionId": sid, "title": (titles.get(sid) or {}).get("title"),
            "project": s["project"], "surface": s["surface"], "cost": s["cost"], "tokens": s["tokens"],
            "count": s["count"], "models": s["models"], "first_ts": s["first_ts"], "last_ts": s["last_ts"],
        })

    counts = sorted(s["count"] for s in session_list)
    by_count = sorted(session_list, key=lambda x: -x["count"])
    longest = by_count[0] if by_count else None
    session_stats = {
        "count": len(session_list),
        "median_msgs": percentile(counts, 0.5),
        "p90_msgs": percentile(counts, 0.9),
        "max_msgs": counts[-1] if counts else 0,
        "over_500": sum(1 for c in counts if c > 500),
        "over_1000": sum(1 for c in counts if c > 1000),
        "over_2000": sum(1 for c in counts if c > 2000),
        "longest_session": ({"title": longest["title"], "msgs": longest["count"], "cost": longest["cost"],
                             "surface": longest["surface"]} if longest else None),
    }

    # accurate distinct-session count per surface (top_sessions is capped, so can't be derived downstream)
    for s in by_surface:
        by_surface[s]["sessions"] = len(surface_sessions.get(s, ()))

    session_list.sort(key=lambda x: -x["cost"])
    day_list = [{"day": day, **by_day[day]} for day in sorted(by_day.keys())]
    total_cost = sum(b["cost"] for b in by_day.values())
    total_tokens = sum(b["tokens"] for b in by_day.values())

    output = {
        "generated_at": datetime.now(tz).isoformat(),
        "earliest_ts": earliest, "latest_ts": latest, "timezone": tz_name,
        "total_cost": total_cost, "total_tokens": total_tokens,
        "total_messages": total_messages, "parsed_messages": parsed_messages,
        "unknown_models": unknown_models,
        "days": day_list, "by_model": by_model, "by_surface": by_surface,
        "top_sessions": session_list[:100], "total_sessions": len(session_list),
        "session_stats": session_stats,
    }
    output["_stats"] = {"dup_line_count": dup_line_count, "dup_groups_count": dup_groups_count}
    return output


def main():
    ap = argparse.ArgumentParser(description="Generate data.json for the claudemeter dashboard.")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json"),
                    help="output path (default: data.json beside this script)")
    ap.add_argument("--tz", default=os.environ.get("CLAUDEMETER_TZ") or local_tz_name(),
                    help="IANA timezone for day bucketing (default: your system's local timezone)")
    ap.add_argument("--root", action="append", default=None,
                    help="scan this root instead of the defaults (repeatable)")
    args = ap.parse_args()

    roots = args.root if args.root else DEFAULT_ROOTS
    out = build(roots, args.tz)
    stats = out.pop("_stats")

    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)

    print(f"Wrote {args.out}")
    print(f"De-duplicated {stats['dup_line_count']} repeated content-block lines "
          f"across {stats['dup_groups_count']} API calls")
    print(f"Total messages with usage: {out['total_messages']}, parsed (priced): {out['parsed_messages']}")
    print(f"Unknown models: {out['unknown_models']}")
    print(f"Total cost: ${out['total_cost']:,.2f}")
    print(f"Date range: {out['earliest_ts']} .. {out['latest_ts']}")
    print(f"Days: {len(out['days'])}, Sessions: {out['total_sessions']}")


if __name__ == "__main__":
    main()
