#!/usr/bin/env python3
"""Mac-only InstaBox account setup. Cloud operations are read-only."""

import argparse
import ctypes
import datetime
import json
import os
from pathlib import Path
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

SERVICE = "win7-coding-agent.instabox"
DEFAULT_CONFIG = Path.home() / ".config/win7-coding-agent/instabox/accounts.json"
API = "https://api.instabox.sh/v1/"
ALIAS = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}\Z")
TOKEN = re.compile(rb"ibk_[a-z0-9]{32,128}\Z")
# Claude Code long-lived token from `claude setup-token`, used only as CLAUDE_CODE_OAUTH_TOKEN on work machines.
CLAUDE_SERVICE = "win7-coding-agent.claude-oauth"
CLAUDE_TOKEN = re.compile(rb"sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,400}\Z")
KINDS = {"instabox": (SERVICE, TOKEN), "claude-oauth": (CLAUDE_SERVICE, CLAUDE_TOKEN)}


class SetupError(Exception):
    pass


class Keychain:
    """Keep passwords out of process arguments, files, and command output."""

    def __init__(self, service=SERVICE):
        self.service = service
        if sys.platform != "darwin":
            raise SetupError("MAC_KEYCHAIN_REQUIRED")
        self.api = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
        self.api.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_bool]
        self.api.SecKeychainSetUserInteractionAllowed.restype = ctypes.c_int32
        status = self.api.SecKeychainSetUserInteractionAllowed(False)
        if status:
            raise SetupError("KEYCHAIN_INTERACTION_CONFIGURATION_FAILED")
        self.api.SecKeychainFindGenericPassword.argtypes = [
            ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
            ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32),
            ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
        ]
        self.api.SecKeychainFindGenericPassword.restype = ctypes.c_int32
        self.api.SecKeychainAddGenericPassword.argtypes = [
            ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
            ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        self.api.SecKeychainAddGenericPassword.restype = ctypes.c_int32
        self.api.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.api.SecKeychainItemFreeContent.restype = ctypes.c_int32

    def read(self, alias):
        service, account = self.service.encode(), alias.encode()
        length, pointer = ctypes.c_uint32(), ctypes.c_void_p()
        status = self.api.SecKeychainFindGenericPassword(
            None, len(service), service, len(account), account,
            ctypes.byref(length), ctypes.byref(pointer), None,
        )
        if status == -25300:
            return None
        if status:
            raise SetupError("KEYCHAIN_READ_FAILED_STATUS_" + str(status))
        try:
            return ctypes.string_at(pointer, length.value)
        finally:
            self.api.SecKeychainItemFreeContent(None, pointer)

    def add(self, alias, secret, pattern=TOKEN):
        if not ALIAS.fullmatch(alias) or not pattern.fullmatch(secret):
            raise SetupError("INVALID_ALIAS_OR_CREDENTIAL_FORMAT")
        existing = self.read(alias)
        if existing is not None:
            if existing != secret:
                raise SetupError("KEYCHAIN_ITEM_EXISTS_DIFFERENT_CREDENTIAL_USE_NEW_ALIAS")
            return "ALREADY_PRESENT"
        service, account = self.service.encode(), alias.encode()
        status = self.api.SecKeychainAddGenericPassword(
            None, len(service), service, len(account), account,
            len(secret), secret, None,
        )
        if status:
            raise SetupError("KEYCHAIN_ADD_FAILED_STATUS_" + str(status))
        if self.read(alias) != secret:
            raise SetupError("KEYCHAIN_READBACK_MISMATCH")
        return "STORED_AND_READBACK_MATCHED"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get_json(opener, key, route):
    request = urllib.request.Request(
        API + route, headers={"X-API-Key": key.decode("ascii"), "Accept": "application/json"},
    )
    try:
        with opener.open(request, timeout=25) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                return None, {"code": "RESPONSE_TOO_LARGE"}
            body = json.loads(raw)
            if not isinstance(body, dict):
                return None, {"code": "INVALID_JSON_OBJECT"}
            return response.status, body
    except urllib.error.HTTPError as error:
        try:
            failure = json.loads(error.read(8192)).get("error", {})
            code = failure.get("code", "HTTP_ERROR")
            if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,80}", code):
                code = "HTTP_ERROR"
            scopes = failure.get("requiredScopes", [])
            scopes = [s for s in scopes if isinstance(s, str) and re.fullmatch(r"[a-z:_]{1,80}", s)]
            return error.code, {"code": code, "requiredScopes": scopes}
        except (ValueError, AttributeError, TypeError):
            return error.code, {"code": "HTTP_ERROR"}
    except (OSError, ValueError):
        return None, {"code": "TRANSPORT_OR_JSON_ERROR"}


def project(body, names):
    return {name: body[name] for name in names if name in body}


def check_account(account, keychain):
    alias = account["alias"]
    key = keychain.read(account["keychainAccount"])
    if key is None or not TOKEN.fullmatch(key):
        raise SetupError("KEYCHAIN_CREDENTIAL_MISSING_OR_INVALID")
    opener = urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    result = {"alias": alias, "expectedOrgId": account["expectedOrgId"], "endpoints": {}}
    success = True
    for route in ("me", "orgs", "usage", "machines?limit=100", "templates"):
        status, body = get_json(opener, key, route)
        name = route.split("?")[0]
        entry = {"httpStatus": status}
        if status != 200:
            entry.update(body)
            success = False
        elif name == "me":
            entry.update(project(body, ("userId", "orgId", "activated", "inviteRequired")))
            result["identityMatched"] = body.get("orgId") == account["expectedOrgId"]
            if not result["identityMatched"]:
                result["endpoints"][name] = entry
                result["result"] = "IDENTITY_MISMATCH"
                return result, False
        elif name == "orgs":
            entry["orgs"] = [project(org, ("id", "kind", "personal", "role", "tier", "disabledAt", "cardMissingAt"))
                             for org in body.get("orgs", [])]
        elif name == "usage":
            entry.update(project(body, ("machines", "snapshots", "allocatedDiskGiB", "storedBytes", "computedAt")))
            entry["limits"] = project(body.get("limits", {}),
                                      ("maxMachines", "maxSnapshots", "maxStoredGiB", "machineSpec"))
        elif name == "machines":
            machines = list(body.get("machines", []))
            cursor = body.get("nextCursor")
            pages = 1
            while cursor and pages < 20:
                next_status, next_body = get_json(opener, key, "machines?limit=100&cursor=" + urllib.parse.quote(cursor, safe=""))
                if next_status != 200:
                    break
                machines.extend(next_body.get("machines", []))
                cursor = next_body.get("nextCursor")
                pages += 1
            entry["complete"] = not bool(cursor)
            entry["machines"] = [project(machine, ("id", "name", "orgId", "state", "spec", "template", "vault"))
                                 for machine in machines]
            success = success and entry["complete"]
        else:
            entry["templateIds"] = sorted({template["id"] for template in body.get("templates", [])})
        result["endpoints"][name] = entry
        if name == "me" and status != 200:
            break
    result["writePermissions"] = "NOT_PERFORMED"
    result["result"] = "PASS" if success else "INCOMPLETE"
    return result, success


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Refuse overwriting reports or following a symlink at the output path.
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    actions = parser.add_subparsers(dest="action", required=True)
    check = actions.add_parser("check", help="Read account identity, quotas and machine inventory")
    check.add_argument("--account", action="append", default=[])
    check.add_argument("--output", type=Path)
    store = actions.add_parser("store", help="Add a Keychain credential from a private input file")
    store.add_argument("--account", required=True)
    store.add_argument("--secret-file", type=Path, required=True)
    store.add_argument("--kind", choices=sorted(KINDS), default="instabox")
    args = parser.parse_args()
    if args.action == "store":
        secret = args.secret_file.read_bytes().strip()
        service, pattern = KINDS[args.kind]
        print(json.dumps({"alias": args.account, "kind": args.kind,
                          "keychain": Keychain(service).add(args.account, secret, pattern)}))
        return
    config = json.loads(args.config.read_text(encoding="utf-8"))
    accounts = config["accounts"]
    aliases = [account["alias"] for account in accounts]
    if len(aliases) != len(set(aliases)) or any(not ALIAS.fullmatch(alias) for alias in aliases):
        raise SetupError("INVALID_OR_DUPLICATE_ACCOUNT_ALIAS")
    if any(not ALIAS.fullmatch(account["keychainAccount"]) for account in accounts):
        raise SetupError("INVALID_KEYCHAIN_ACCOUNT_ALIAS")
    if set(args.account) - set(aliases):
        raise SetupError("UNKNOWN_ACCOUNT_ALIAS")
    selected = [a for a in accounts if not args.account or a["alias"] in args.account]
    if not selected:
        raise SetupError("NO_ACCOUNTS_SELECTED")
    keychain, results, passed = Keychain(), [], True
    for account in selected:
        try:
            result, success = check_account(account, keychain)
        except SetupError as error:
            result, success = {"alias": account["alias"], "result": str(error)}, False
        results.append(result)
        passed = passed and success
    report = {"schemaVersion": 1, "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "evidenceLevel": "开发机", "cloudMutations": 0, "accounts": results}
    if args.output:
        write_json(args.output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except (SetupError, OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        # Do not print exceptions from HTTP or credential providers verbatim.
        message = str(error) if isinstance(error, SetupError) else "LOCAL_INPUT_OR_OUTPUT_ERROR"
        print(json.dumps({"error": message}), file=sys.stderr)
        raise SystemExit(1)
