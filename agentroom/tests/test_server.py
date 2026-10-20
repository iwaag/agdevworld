"""The relay's routes since workflow_editor p15: /budget and /cost (and
/healthz); the retired panels' routes answer 404 with what remains."""

import json
import threading
import urllib.error
import urllib.request

from agentroom.server import ROUTES, build_server


class FakeBudget:
    providers = ()

    def snapshot(self):
        return {"harnesses": {}}


def serve():
    server = build_server("127.0.0.1", 0, cost=None, budget=FakeBudget())
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def get(url):
    try:
        with urllib.request.urlopen(url) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def test_only_budget_and_cost_remain():
    server, base = serve()
    try:
        assert get(f"{base}/")[1]["routes"] == list(ROUTES) == ["/healthz", "/budget", "/cost"]
        assert get(f"{base}/healthz") == (200, {"ok": True})
        assert get(f"{base}/budget") == (200, {"harnesses": {}})
        status, body = get(f"{base}/cost")
        assert status == 503 and "AGENTROOM_AGENT_ROOTS" in body["error"]
        for retired in ("/settings", "/progress", "/argues", "/contexts"):
            status, body = get(f"{base}{retired}")
            assert status == 404 and body["routes"] == list(ROUTES)
    finally:
        server.shutdown()
