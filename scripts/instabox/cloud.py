#!/usr/bin/env python3
"""Bounded InstaBox operations using Mac Keychain account references."""

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# The directory is this checked-in tool's directory, not downloaded input.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from accounts import API, DEFAULT_CONFIG, Keychain, NoRedirect, SetupError, write_json


class CloudError(SetupError):
    pass


class Client:
    def __init__(self, alias, config=DEFAULT_CONFIG):
        accounts = json.loads(Path(config).read_text(encoding="utf-8"))["accounts"]
        matches = [account for account in accounts if account["alias"] == alias]
        if len(matches) != 1:
            raise CloudError("UNKNOWN_OR_DUPLICATE_ACCOUNT")
        self.account = matches[0]
        key = Keychain().read(self.account["keychainAccount"])
        if not key:
            raise CloudError("KEYCHAIN_CREDENTIAL_MISSING")
        self.key = key.decode("ascii")
        self.opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )
        me = self.request("GET", "me")
        if me.get("orgId") != self.account["expectedOrgId"]:
            raise CloudError("ACCOUNT_IDENTITY_MISMATCH")

    def request(self, method, route, payload=None, headers=None, timeout=40):
        if route.startswith("/") or ":" in route.split("?")[0] or ".." in route.split("/"):
            raise CloudError("INVALID_API_ROUTE")
        request_headers = {"X-API-Key": self.key, "Accept": "application/json"}
        request_headers.update(headers or {})
        if payload is not None and not isinstance(payload, bytes):
            payload = json.dumps(payload).encode()
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(API + route, data=payload, headers=request_headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                # Token revocation returns HTTP 204 with no JSON body.
                if response.status == 204:
                    return {}
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise CloudError("RESPONSE_TOO_LARGE")
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            try:
                body = json.loads(error.read(8192)).get("error", {})
                code = body.get("code", "HTTP_ERROR")
                if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,80}", code):
                    code = "HTTP_ERROR"
                scopes = body.get("requiredScopes", [])
                scopes = [s for s in scopes if isinstance(s, str) and re.fullmatch(r"[a-z:_]{1,80}", s)]
                detail = {"httpStatus": error.code, "code": code, "requiredScopes": scopes,
                          "retryAfterSeconds": body.get("retryAfterSeconds")}
            except (ValueError, TypeError, AttributeError):
                detail = {"httpStatus": error.code, "code": "HTTP_ERROR"}
            raise CloudError(json.dumps(detail)) from None
        except (OSError, ValueError) as error:
            # Keep only non-secret error classes, never the request, headers or response body.
            reason = getattr(error, "reason", None)
            self.last_transport_error = {"type": type(error).__name__,
                                         "reasonType": type(reason).__name__ if reason is not None else None,
                                         "errno": getattr(error, "errno", None)}
            # Never retry exec: it may already have run. Retry creates with their saved idempotency key.
            raise CloudError("TRANSPORT_OR_JSON_ERROR_RECONCILE_BEFORE_RETRY") from None

    def machine(self, machine_id):
        if not re.fullmatch(r"m_[a-z0-9]+", machine_id):
            raise CloudError("INVALID_MACHINE_ID")
        machine = self.read("machines/" + machine_id)
        if machine.get("orgId") != self.account["expectedOrgId"]:
            raise CloudError("MACHINE_WORKSPACE_MISMATCH")
        return machine

    def wait(self, operation, seconds=50):
        deadline = time.monotonic() + seconds
        while operation.get("state") not in ("succeeded", "failed") and time.monotonic() < deadline:
            remaining = min(25, max(1, int(deadline - time.monotonic())))
            operation = self.read("operations/" + operation["id"] + "?wait=" + str(remaining) + "s")
        return operation

    # --- Work-package operations (design r4). Every mutation keeps the no-blind-retry rule. ---

    TRANSPORT_ERROR = "TRANSPORT_OR_JSON_ERROR_RECONCILE_BEFORE_RETRY"
    READ_RETRY_DELAYS = (5, 10, 20, 30, 30, 30)

    def _retry_reads(self, action, sleep):
        """Run a read-only action; retry transport errors with backoff. Returns (value, retries)."""
        retries = []
        for attempt, delay in enumerate((0,) + self.READ_RETRY_DELAYS, start=1):
            if delay:
                sleep(delay)
            try:
                return action(), retries
            except CloudError as error:
                if str(error) != self.TRANSPORT_ERROR:
                    raise
                retries.append({"failedAttempt": attempt,
                                "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                "error": str(error)})
        raise CloudError("READ_RESULT_UNAVAILABLE_AFTER_RETRIES")

    def retry_safe(self, action, sleep=time.sleep):
        """Run an action that can be repeated without changing the outcome (a read or an overwrite)."""
        return self._retry_reads(action, sleep)[0]

    def read(self, route, sleep=time.sleep):
        """GET with bounded retries; a GET cannot change state, so a lost reply is safe to ask again."""
        return self._retry_reads(lambda: self.request("GET", route), sleep)[0]

    def create_from_snapshot(self, name, snapshot_id, idempotency_key, delete_after_seconds=14400):
        """Start a machine from a login snapshot; returns the accepted operation, not the machine."""
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name):
            raise CloudError("INVALID_MACHINE_NAME")
        if not re.fullmatch(r"sn_[a-z0-9]+", snapshot_id):
            raise CloudError("INVALID_SNAPSHOT_ID")
        if not 60 <= delete_after_seconds <= 86400:
            raise CloudError("INVALID_DELETE_AFTER_SECONDS")
        payload = {"name": name, "snapshotId": snapshot_id, "deleteAfterSeconds": delete_after_seconds,
                   "metadata": {"project": "win7-coding-agent", "task": "engineering-06"}}
        return self.request("POST", "machines", payload, {"Idempotency-Key": idempotency_key})

    def delete_machine(self, machine_id, expected_name, idempotency_key):
        """Delete only after the name matches; the caller must have collected every result first."""
        machine = self.machine(machine_id)
        if machine.get("name") != expected_name:
            raise CloudError("MACHINE_NAME_MISMATCH")
        operation = self.request("DELETE", "machines/" + machine_id,
                                 headers={"X-Confirm-Delete": machine_id, "Idempotency-Key": idempotency_key})
        return self.wait(operation)

    def wake(self, machine_id):
        self.machine(machine_id)
        return self.request("POST", "machines/" + machine_id + "/wake")

    def lease(self, machine_id, lease_id, ttl_seconds):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", lease_id):
            raise CloudError("INVALID_LEASE_ID")
        if not 30 <= ttl_seconds <= 3600:
            raise CloudError("INVALID_LEASE_TTL")
        self.machine(machine_id)
        return self.request("PUT", "machines/" + machine_id + "/activity-leases/" + lease_id,
                            {"ttlSeconds": ttl_seconds})

    def release_lease(self, machine_id, lease_id):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", lease_id):
            raise CloudError("INVALID_LEASE_ID")
        self.machine(machine_id)
        return self.request("DELETE", "machines/" + machine_id + "/activity-leases/" + lease_id)

    def disk(self, machine_id):
        self.machine(machine_id)
        return self.read("machines/" + machine_id + "/disk")

    def processes(self, machine_id):
        self.machine(machine_id)
        return self.read("machines/" + machine_id + "/processes")

    def exec_once(self, machine_id, argv, timeout_seconds):
        """Run one command that changes state or starts work. A transport error is never retried here."""
        self.machine(machine_id)
        if not 1 <= timeout_seconds <= 600:
            raise CloudError("INVALID_EXEC_TIMEOUT")
        return self.request("POST", "machines/" + machine_id + "/exec",
                            {"argv": list(argv), "timeoutSeconds": timeout_seconds, "noHistory": True},
                            timeout=timeout_seconds + 15)

    def read_exec(self, machine_id, argv, timeout_seconds, sleep=time.sleep):
        """Run one read-only command (job status or collect). Retries transport errors up to six times.

        Returns (response, retries). Each retry is recorded for the evidence file. HTTP errors are not retried.
        """
        return self._retry_reads(lambda: self.exec_once(machine_id, argv, timeout_seconds), sleep)


def redact(value):
    if isinstance(value, str):
        value = re.sub(r"ibk_[a-z0-9]+", "[REDACTED_INSTABOX_KEY]", value)
        return re.sub(r"(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}", "[REDACTED_TOKEN]", value)
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path, required=True)
    actions = parser.add_subparsers(dest="action", required=True)
    get = actions.add_parser("get")
    get.add_argument("route")
    delete = actions.add_parser("delete")
    delete.add_argument("machine_id")
    delete.add_argument("--expected-name", required=True)
    delete.add_argument("--idempotency-key", required=True)
    create = actions.add_parser("create")
    create.add_argument("--name", required=True)
    create.add_argument("--template-version", required=True)
    create.add_argument("--idempotency-key", required=True)
    execute = actions.add_parser("exec")
    execute.add_argument("machine_id")
    execute.add_argument("--request", type=Path, required=True)
    upload = actions.add_parser("upload")
    upload.add_argument("machine_id")
    upload.add_argument("--file", type=Path, required=True)
    upload.add_argument("--path", required=True)
    upload.add_argument("--mode", default="0600")
    wait = actions.add_parser("wait")
    wait.add_argument("operation_id")
    args = parser.parse_args()
    # Reserve evidence before a mutation, so a local output failure cannot orphan a new sandbox.
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    evidence_fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    result = {"account": args.account, "action": args.action,
              "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    passed = False
    try:
        client = Client(args.account, args.config)
        if args.action == "get":
            response = client.request("GET", args.route)
        elif args.action == "delete":
            machine = client.machine(args.machine_id)
            if machine.get("name") != args.expected_name:
                raise CloudError("MACHINE_NAME_MISMATCH")
            result["before"] = {key: machine.get(key) for key in ("id", "name", "state", "orgId")}
            result["idempotencyKey"] = args.idempotency_key
            response = client.request("DELETE", "machines/" + args.machine_id,
                                      headers={"X-Confirm-Delete": args.machine_id,
                                               "Idempotency-Key": args.idempotency_key})
            response = client.wait(response)
        elif args.action == "create":
            result["idempotencyKey"] = args.idempotency_key
            payload = {"name": args.name, "templateId": "agent-browser",
                       "templateVersion": args.template_version, "vault": False,
                       "deleteAfterSeconds": 14400,
                       "metadata": {"project": "win7-coding-agent", "task": "engineering-06"}}
            result["request"] = payload
            response = client.wait(client.request("POST", "machines", payload,
                                   {"Idempotency-Key": args.idempotency_key}))
        elif args.action == "exec":
            client.machine(args.machine_id)
            request = json.loads(args.request.read_text(encoding="utf-8"))
            response = client.request("POST", "machines/" + args.machine_id + "/exec", request,
                                      timeout=min(600, request.get("timeoutSeconds", 60)) + 15)
        elif args.action == "upload":
            client.machine(args.machine_id)
            route = "machines/" + args.machine_id + "/files?" + urllib.parse.urlencode(
                {"path": args.path, "mode": args.mode, "parents": "true"})
            response = client.request("PUT", route, args.file.read_bytes(),
                                      {"Content-Type": "application/octet-stream"}, timeout=60)
        else:
            if not re.fullmatch(r"op_[a-z0-9]+", args.operation_id):
                raise CloudError("INVALID_OPERATION_ID")
            response = client.wait(client.request("GET", "operations/" + args.operation_id))
        result["response"] = response
        if args.action in ("create", "delete", "wait"):
            passed = response.get("state") == "succeeded"
            result["result"] = ("PASS" if passed else
                                "UNKNOWN" if response.get("state") in ("queued", "running") else "FAIL")
        elif args.action == "exec":
            passed = (response.get("exitCode") == 0
                      and not any(response.get(flag) for flag in ("timedOut", "truncated", "oomKilled")))
            result["result"] = "PASS" if passed else "FAIL"
        else:
            passed = True
            result["result"] = "PASS"
    except (SetupError, OSError, ValueError, KeyError, TypeError) as error:
        result["error"] = str(error) if isinstance(error, SetupError) else "LOCAL_OR_RESPONSE_ERROR"
        result["result"] = "FAIL"
    finally:
        result["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        result = redact(result)
        with os.fdopen(evidence_fd, "w", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        print(json.dumps(result, ensure_ascii=False))
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
