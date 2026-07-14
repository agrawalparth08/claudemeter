#!/usr/bin/env python3
"""Generate the synthetic parity fixture tree under test/fixtures/home/.

Covers every branch the ETL has: both trees, per-request dedup (one turn split
across content-block lines), <synthetic> skip, unknown model, 5m/1h cache split,
the missing-breakdown fallback, Sonnet-5 pricing on each side of the intro
cutover, a dated-haiku normalize, a no-timestamp skip, a non-assistant line, a
malformed line, audit.jsonl skip, and Desktop + Cowork title files.

The emitted tree is git-ignored and regenerated on every `npm test` (which runs
this script, then parity.mjs); it is not committed.
"""
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "fixtures", "home")


def usage(inp=0, out=0, cr=0, c5=0, c1=0):
    cc_total = c5 + c1
    return {
        "input_tokens": inp, "output_tokens": out,
        "cache_read_input_tokens": cr, "cache_creation_input_tokens": cc_total,
        "cache_creation": {"ephemeral_5m_input_tokens": c5, "ephemeral_1h_input_tokens": c1},
    }


def asst(rid, mid, model, u, ts, ep, sid, ctype="text"):
    return {
        "type": "assistant", "requestId": rid, "uuid": "uuid-" + rid,
        "timestamp": ts, "entrypoint": ep, "sessionId": sid,
        "message": {"id": mid, "model": model, "role": "assistant",
                    "content": [{"type": ctype, "text": "x"}], "usage": u},
    }


def write_jsonl(relpath, records):
    fp = os.path.join(ROOT, relpath)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, "w") as f:
        for r in records:
            if isinstance(r, str):
                f.write(r + "\n")          # raw line (malformed / non-assistant)
            else:
                f.write(json.dumps(r) + "\n")


def write_json(relpath, obj):
    fp = os.path.join(ROOT, relpath)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, "w") as f:
        json.dump(obj, f)


def main():
    if os.path.isdir(os.path.join(HERE, "fixtures")):
        shutil.rmtree(os.path.join(HERE, "fixtures"))

    # ---- main tree: ~/.claude/projects/proj-main/s-main.jsonl ----
    main_records = [
        # dedup: same requestId across two content-block lines -> counted once
        asst("req1", "m1", "claude-opus-4-8", usage(100, 50, 200, 80, 0), "2026-05-10T08:00:00.000Z", "claude-desktop", "sess-main", "thinking"),
        asst("req1", "m1", "claude-opus-4-8", usage(100, 50, 200, 80, 0), "2026-05-10T08:00:01.000Z", "claude-desktop", "sess-main", "text"),
        # sonnet-5 BEFORE intro cutover -> intro pricing (2/10); 1h cache
        asst("req2", "m2", "claude-sonnet-5", usage(1000, 200, 0, 0, 500), "2026-07-01T10:00:00.000Z", "cli", "sess-main"),
        # sonnet-5 AFTER intro cutover -> standard pricing (3/15)
        asst("req3", "m3", "claude-sonnet-5", usage(1000, 200, 0, 0, 0), "2026-09-01T10:00:00.000Z", "sdk-cli", "sess-sdk"),
        # <synthetic> -> skipped entirely
        asst("req4", "m4", "<synthetic>", usage(0, 0, 0, 0, 0), "2026-05-10T09:00:00.000Z", "claude-desktop", "sess-main"),
        # unknown model -> unknown_models, not priced
        asst("req5", "m5", "claude-unknown-9", usage(10, 5, 0, 0, 0), "2026-05-10T09:05:00.000Z", "claude-desktop", "sess-main"),
        # missing cache breakdown (5m=1h=0) but cache_creation>0 -> fallback all-5m
        {"type": "assistant", "requestId": "req6", "uuid": "uuid-req6", "timestamp": "2026-05-11T08:00:00.000Z",
         "entrypoint": "claude-desktop", "sessionId": "sess-main",
         "message": {"id": "m6", "model": "claude-opus-4-8", "role": "assistant", "content": [{"type": "text", "text": "x"}],
                     "usage": {"input_tokens": 50, "output_tokens": 10, "cache_read_input_tokens": 0,
                               "cache_creation_input_tokens": 40,
                               "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}}},
        # dated haiku -> normalizes to claude-haiku-4-5; NO timestamp -> counted in total but skipped from pricing
        {"type": "assistant", "requestId": "req7", "uuid": "uuid-req7", "entrypoint": "claude-desktop", "sessionId": "sess-main",
         "message": {"id": "m7", "model": "claude-haiku-4-5-20251001", "role": "assistant",
                     "content": [{"type": "text", "text": "x"}], "usage": usage(20, 5, 0, 0, 0)}},
        # non-assistant line -> ignored
        {"type": "user", "message": {"role": "user", "content": "hi"}, "timestamp": "2026-05-10T07:00:00.000Z"},
        # malformed json -> skipped
        "not json {{{",
    ]
    write_jsonl("dotclaude/projects/proj-main/s-main.jsonl", main_records)

    # subagent transcript (additive, separate session)
    write_jsonl("dotclaude/projects/proj-main/subagents/agent-x.jsonl", [
        asst("req8", "m8", "claude-fable-5", usage(5000, 3000, 10000, 2000, 0), "2026-06-15T12:00:00.000Z", "claude-desktop", "sess-sub"),
    ])

    # ---- cowork tree ----
    cw_base = "Library/Application Support/Claude/local-agent-mode-sessions/org/ws"
    write_jsonl(f"{cw_base}/local_abc123def456/.claude/projects/proj-cw/s-cowork.jsonl", [
        asst("req9", "m9", "claude-opus-4-8", usage(300, 80, 0, 0, 5000), "2026-06-08T08:00:00.000Z", "local-agent", "sess-cowork"),
        asst("req10", "m10", "claude-opus-4-8", usage(150, 40, 6000, 100, 0), "2026-06-08T08:05:00.000Z", "local-agent", "sess-cowork"),
    ])
    # cowork audit file -> must be skipped
    write_jsonl(f"{cw_base}/local_abc123def456/audit.jsonl", [{"type": "audit", "event": "x"}])
    # cowork title metadata
    write_json(f"{cw_base}/local_abc123def456.json", {"cliSessionId": "sess-cowork", "title": "Cowork Fixture Task", "processName": "happy-fixture-turing"})

    # ---- desktop title metadata ----
    write_json("Library/Application Support/Claude/claude-code-sessions/org/ws/local_deadbeef01.json",
               {"cliSessionId": "sess-main", "title": "Main Fixture Session"})

    print(f"Wrote fixtures under {ROOT}")


if __name__ == "__main__":
    main()
