"""One read-only login probe using Var Grid's standard-library HTTP client.

The only credential input is stdin. Never print upstream bodies or exception text.
"""
import json
import re
import socket
import sys
import time
import urllib.error
import urllib.request

URL = "https://omni.variational.io/api/me"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"
MAX_BYTES = 2 * 1024 * 1024
MAX_INPUT_BYTES = 8192


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def content_kind(value):
    mime = (value or "").split(";", 1)[0].strip().lower()
    if not mime:
        return "missing"
    if mime == "application/json" or re.fullmatch(r"application/[a-z0-9.+-]+\+json", mime):
        return "json"
    if mime in ("text/html", "application/xhtml+xml"):
        return "html"
    return "other"


def valid_token(value):
    return isinstance(value, str) and 5 <= len(value) <= 4096 and re.fullmatch(r"[A-Za-z0-9._~-]+", value) is not None


def probe(token, opener=None):
    if not valid_token(token):
        raise ValueError("Invalid diagnostic input")
    started = time.monotonic()
    result = {"endpoint": "session", "path": "/api/me", "status": None,
              "contentType": None, "challenge": False, "elapsedMs": 0,
              "structureOk": None, "outcome": "network_error"}
    response = None
    try:
        # Match Grid's Client.request login path, including its three headers.
        request = urllib.request.Request(URL, headers={
            "Cookie": "vr-token=" + token, "User-Agent": USER_AGENT, "Accept": "application/json",
        }, method="GET")
        client = opener if opener is not None else urllib.request.build_opener(NoRedirect())
        try:
            response = client.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        status = response.getcode()
        result["status"] = status if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599 else None
        result["contentType"] = content_kind(response.headers.get("Content-Type"))
        result["challenge"] = response.headers.get("cf-mitigated", "").strip().lower() == "challenge"
        if result["challenge"]:
            result["outcome"] = "challenge"
        elif isinstance(status, int) and 300 <= status < 400:
            result["outcome"] = "redirect"
        elif status in (401, 403, 429):
            result["outcome"] = {401: "unauthorized", 403: "forbidden", 429: "rate_limited"}[status]
        elif not isinstance(status, int) or not 200 <= status < 300:
            result["outcome"] = "network_error"
        elif result["contentType"] == "html":
            result["outcome"] = "html"
        elif result["contentType"] != "json":
            result["outcome"] = "invalid_data"
        else:
            length = response.headers.get("Content-Length")
            if length and length.isdecimal() and int(length) > MAX_BYTES:
                raise ValueError("Invalid diagnostic response")
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError("Invalid diagnostic response")
            data = json.loads(body)
            returned_token = data.get("token") if isinstance(data, dict) else None
            # Attest only to structure, never to authentication or token validity.
            result["structureOk"] = isinstance(returned_token, str) and 0 < len(returned_token) <= 32768
            result["outcome"] = "ok" if result["structureOk"] else "invalid_data"
    except (socket.timeout, TimeoutError):
        result["outcome"] = "timeout"
    except urllib.error.URLError as error:
        result["outcome"] = "timeout" if isinstance(error.reason, (socket.timeout, TimeoutError)) else "network_error"
    except (ValueError, UnicodeError, RecursionError):
        result["structureOk"] = False
        result["outcome"] = "invalid_data"
    except Exception:
        result["outcome"] = "network_error"
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
        result["elapsedMs"] = max(0, round((time.monotonic() - started) * 1000))
    return result


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            return 2
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {"vrToken"} or not valid_token(value["vrToken"]):
            return 2
        result = probe(value["vrToken"])
        sys.stdout.write(json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n")
        return 0
    except Exception:
        return 2


if __name__ == "__main__":
    sys.exit(main())
