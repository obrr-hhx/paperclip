#!/usr/bin/env python3
"""Thin Paperclip API/discovery client. No model invocation or scheduling."""
import argparse
import json
import os
import pathlib
import sys
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("method", choices=["discover", "GET", "POST", "bind"])
parser.add_argument("route", nargs="?")
parser.add_argument("--url", default=os.environ.get("PAPERCLIP_API_URL"))
parser.add_argument("--notify-endpoint", default=os.environ.get("PAPERCLIP_CODEX_NOTIFY_ENDPOINT", "local"))
parser.add_argument("--notify-thread", default=os.environ.get("CODEX_THREAD_ID"))
args = parser.parse_args()
if args.method == "discover":
    root = pathlib.Path(os.environ.get("PAPERCLIP_TASK_POOL_HOME", str(pathlib.Path.home() / ".paperclip")))
    print(json.dumps({"notifications": sorted(str(p) for p in (root / "inbox").glob("*.json")),
                      "requirements": sorted(str(p) for p in (root / "requirements").glob("*/*/SUMMARY.md"))}, indent=2))
else:
    if not args.url or not args.route:
        parser.error("--url (or PAPERCLIP_API_URL) and API route are required")
    headers = {}
    key = os.environ.get("PAPERCLIP_API_KEY")
    if key:
        headers["Authorization"] = "Bearer " + key
    url = args.url.rstrip("/") + ("" if args.url.rstrip("/").endswith("/api") else "/api") + "/" + args.route.lstrip("/")

    def send(method, body=None):
        payload = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=payload, headers={**headers, "Content-Type": "application/json"}, method=method)
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    if args.method == "bind":
        if not args.notify_endpoint or not args.notify_thread:
            parser.error("bind requires --notify-endpoint and --notify-thread (or their environment variables)")
        body = {"action": "bind_planner", "notification": {
            "provider": "codex", "endpoint": args.notify_endpoint, "threadId": args.notify_thread}}
        args.method = "POST"
    else:
        body = json.load(sys.stdin) if args.method == "POST" else None
        if body and args.route.rstrip("/").endswith("/task-pool") and args.notify_endpoint and args.notify_thread:
            body.setdefault("plannerNotification", {"provider": "codex", "endpoint": args.notify_endpoint, "threadId": args.notify_thread})
    # A verdict may use a planner session instead of exposing a claim capability
    # through terminal output or persisting it between invocations.
    if body and body.get("action") in ("accept", "rework") and "session" in body:
        session = body.pop("session")
        claim = send("POST", {"action": "claim_review", "session": session})
        body["token"] = claim["state"]["review"]["token"]
    result = send(args.method, body)
    if isinstance(result, dict) and isinstance(result.get("state"), dict) and result["state"].get("review"):
        result["state"]["review"]["token"] = "[redacted]"
    print(json.dumps(result, ensure_ascii=False, indent=2))
