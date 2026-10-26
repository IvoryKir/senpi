"""Synchronous, invocation-scoped permission checks over the existing loopback bridge."""
import contextvars
import json
import mmap
import os
import socket
import struct
import time
import uuid
import importlib
import importlib.util
from typing import NoReturn

_spec = importlib.util.spec_from_file_location("_senpi_interpose", os.path.join(os.path.dirname(__file__), "interpose.py"))
if _spec is None or _spec.loader is None:
    raise RuntimeError("Python permission interposition asset is unavailable")
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
install = _module.install


class CellPermissionError(RuntimeError):
    code = "cell_permission_denied"

    def __init__(self, reason, rule=None):
        self.permissionRule = rule
        identity = (f"{rule['permission']} {rule['pattern']} ({rule['layer']})"
                    if rule else "permission authority unavailable")
        super().__init__(f"Cell operation refused: {identity}: {reason}")


def initialize(config, port):
    # The mapping and captured I/O never enter the user namespace.
    with open(config["path"], "rb") as file:
        words = mmap.mmap(file.fileno(), config["size"], access=mmap.ACCESS_READ)
    context = contextvars.ContextVar("senpi_permission", default=None)
    getcwd = os.getcwd
    socket_type = socket.socket

    def rule():
        token = context.get()
        rules = token.get("rules", []) if token else config.get("rules", [])
        return rules[0] if rules else None

    def refuse(reason, deciding_rule=None) -> NoReturn:
        raise CellPermissionError(reason, deciding_rule or rule())

    def enforcing():
        token = context.get()
        offset = token["offset"] if token else 0
        word = struct.unpack_from("<Q", words, offset)[0]
        if not word & 2:
            refuse("authority revoked")
        if token is None and word & 1:
            refuse("operation has no invocation authority")
        return bool(word & 1)

    def check(tool, input, cwd=None):
        if not enforcing():
            return
        token = context.get()
        if token is None:
            refuse("operation has no invocation authority")
        nonce = uuid.uuid4().hex
        payload = json.dumps({"token": token["id"], "nonce": nonce,
                              "call": {"tool": tool, "input": input, "cwd": cwd or getcwd()}}).encode()
        deadline = time.monotonic() + 2.0
        try:
            with socket_type(socket.AF_INET, socket.SOCK_STREAM) as sock:
                def remaining():
                    seconds = deadline - time.monotonic()
                    if seconds <= 0:
                        raise TimeoutError("permission deadline")
                    sock.settimeout(seconds)
                remaining()
                sock.connect(("127.0.0.1", port))
                remaining()
                sock.sendall(b"POST /permission_check HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                             b"Connection: close\r\nContent-Type: application/json\r\nContent-Length: " +
                             str(len(payload)).encode() + b"\r\n\r\n" + payload)
                response = bytearray()
                while True:
                    remaining()
                    chunk = sock.recv(16384)
                    if not chunk:
                        break
                    response.extend(chunk)
                    if len(response) > 32768:
                        raise ValueError("oversized permission response")
                header, body = bytes(response).split(b"\r\n\r\n", 1)
                if not header.startswith(b"HTTP/1.1 200 "):
                    raise ValueError("permission HTTP failure")
                # Node sends chunked responses unless Content-Length is set by the bridge.
                reply = json.loads(body)
                value = reply["value"]
                if reply.get("ok") is not True or value.get("nonce") != nonce:
                    raise ValueError("permission nonce mismatch")
                decision = value["decision"]
                enforcing()  # A late allow cannot cross revocation.
                if decision.get("action") == "pass":
                    return
                deciding_rule = decision.get("rule")
                if decision.get("action") == "deny" and isinstance(deciding_rule, dict) and all(
                    isinstance(deciding_rule.get(key), str) for key in ("permission", "pattern", "layer")
                ):
                    refuse(str(input), deciding_rule)
                raise ValueError("invalid permission decision")
        except CellPermissionError:
            raise
        except BaseException as exc:
            # KeyboardInterrupt must leave the parked check immediately, never wait for the host.
            refuse(f"permission check failed ({type(exc).__name__})")

    install(check, enforcing, refuse)
    return context
