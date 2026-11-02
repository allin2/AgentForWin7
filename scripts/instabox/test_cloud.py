#!/usr/bin/env python3
"""Response-contract regressions; no network calls or Keychain access."""

import io
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock
import urllib.error

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cloud import Client, CloudError


class Response(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(body)
        self.status = status


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.client = Client.__new__(Client)
        self.client.key = "test-only"
        self.client.opener = Mock()

    def respond(self, status, body):
        self.client.opener.open.return_value = Response(status, body)

    def test_token_revocation_accepts_204_without_retry(self):
        self.respond(204, b"")
        self.assertEqual(
            self.client.request("DELETE", "machines/m_test/ssh-tokens/cn_test"), {},
        )
        self.client.opener.open.assert_called_once()

    def test_json_success_still_returns_payload(self):
        self.respond(200, b'{"tokens": []}')
        self.assertEqual(self.client.request("GET", "machines/m_test/ssh-tokens"), {"tokens": []})

    def test_empty_200_is_not_mistaken_for_204(self):
        self.respond(200, b"")
        with self.assertRaisesRegex(CloudError, "TRANSPORT_OR_JSON_ERROR_RECONCILE_BEFORE_RETRY"):
            self.client.request("GET", "me")
        self.client.opener.open.assert_called_once()

    def test_invalid_json_still_requires_reconciliation(self):
        self.respond(200, b"<html>upstream error</html>")
        with self.assertRaisesRegex(CloudError, "TRANSPORT_OR_JSON_ERROR_RECONCILE_BEFORE_RETRY"):
            self.client.request("GET", "me")
        self.client.opener.open.assert_called_once()

    def test_transport_failure_does_not_retry_mutation(self):
        self.client.opener.open.side_effect = urllib.error.URLError("timeout")
        with self.assertRaisesRegex(CloudError, "TRANSPORT_OR_JSON_ERROR_RECONCILE_BEFORE_RETRY"):
            self.client.request("POST", "machines/m_test/exec", {"argv": ["true"]})
        self.client.opener.open.assert_called_once()

    def test_http_error_keeps_safe_status(self):
        self.client.opener.open.side_effect = urllib.error.HTTPError(
            "https://api.instabox.sh/v1/me", 403, "Forbidden", {},
            io.BytesIO(b'{"error":{"code":"missing_scope","requiredScopes":["machines:read"]}}'),
        )
        with self.assertRaises(CloudError) as result:
            self.client.request("GET", "me")
        self.assertIn('"httpStatus": 403', str(result.exception))
        self.assertIn("missing_scope", str(result.exception))
        self.client.opener.open.assert_called_once()

    def test_oversize_response_still_rejected(self):
        self.respond(200, b"x" * (4 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(CloudError, "RESPONSE_TOO_LARGE"):
            self.client.request("GET", "me")


TRANSPORT = "TRANSPORT_OR_JSON_ERROR_RECONCILE_BEFORE_RETRY"
MACHINE = "m_test"


class WorkPackageTests(unittest.TestCase):
    def setUp(self):
        self.client = Client.__new__(Client)
        self.client.machine = Mock(return_value={"id": MACHINE, "name": "wp-test"})
        self.client.request = Mock()
        self.client.wait = Mock(side_effect=lambda operation, seconds=50: dict(operation, state="succeeded"))

    def test_create_from_snapshot_sends_snapshot_and_idempotency_key(self):
        self.client.request.return_value = {"id": "op_test"}
        self.client.create_from_snapshot("wp-test", "sn_test", "key-1", 7200)
        method, route, payload, headers = self.client.request.call_args.args
        self.assertEqual((method, route, headers), ("POST", "machines", {"Idempotency-Key": "key-1"}))
        self.assertEqual((payload["snapshotId"], payload["deleteAfterSeconds"]), ("sn_test", 7200))
        self.assertNotIn("templateId", payload)

    def test_create_rejects_bad_inputs_without_a_request(self):
        for args in (("Bad Name", "sn_test", "k", 7200), ("wp-test", "x_test", "k", 7200), ("wp-test", "sn_test", "k", 59)):
            with self.assertRaises(CloudError):
                self.client.create_from_snapshot(*args)
        self.client.request.assert_not_called()

    def test_delete_requires_matching_name_and_sends_confirmation(self):
        with self.assertRaisesRegex(CloudError, "MACHINE_NAME_MISMATCH"):
            self.client.delete_machine(MACHINE, "other-name", "key-1")
        self.client.request.assert_not_called()
        self.client.request.return_value = {"id": "op_test"}
        result = self.client.delete_machine(MACHINE, "wp-test", "key-1")
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(self.client.request.call_args.kwargs["headers"],
                         {"X-Confirm-Delete": MACHINE, "Idempotency-Key": "key-1"})

    def test_lease_bounds_and_route(self):
        self.client.request.return_value = {"id": "wp-test"}
        self.client.lease(MACHINE, "wp-test", 3600)
        self.client.request.assert_called_once_with(
            "PUT", "machines/m_test/activity-leases/wp-test", {"ttlSeconds": 3600})
        for ttl in (29, 3601):
            with self.assertRaises(CloudError):
                self.client.lease(MACHINE, "wp-test", ttl)
        with self.assertRaises(CloudError):
            self.client.lease(MACHINE, "Bad Lease", 60)

    def test_exec_once_never_retries_a_transport_error(self):
        self.client.request.side_effect = CloudError(TRANSPORT)
        with self.assertRaisesRegex(CloudError, TRANSPORT):
            self.client.exec_once(MACHINE, ["true"], 10)
        self.assertEqual(self.client.request.call_count, 1)

    def test_read_exec_retries_transport_errors_with_backoff_and_records_them(self):
        delays = []
        self.client.request.side_effect = [CloudError(TRANSPORT), CloudError(TRANSPORT), {"exitCode": 0}]
        response, retries = self.client.read_exec(MACHINE, ["true"], 10, sleep=delays.append)
        self.assertEqual(response, {"exitCode": 0})
        self.assertEqual(delays, [5, 10])
        self.assertEqual([item["failedAttempt"] for item in retries], [1, 2])

    def test_read_exec_gives_up_after_six_retries(self):
        delays = []
        self.client.request.side_effect = CloudError(TRANSPORT)
        with self.assertRaisesRegex(CloudError, "READ_RESULT_UNAVAILABLE_AFTER_RETRIES"):
            self.client.read_exec(MACHINE, ["true"], 10, sleep=delays.append)
        self.assertEqual(delays, [5, 10, 20, 30, 30, 30])
        self.assertEqual(self.client.request.call_count, 7)

    def test_read_retries_a_lost_get_reply_and_machine_uses_it(self):
        delays = []
        self.client.request.side_effect = [CloudError(TRANSPORT), {"id": "x"}]
        self.assertEqual(self.client.read("machines/m_test", sleep=delays.append), {"id": "x"})
        self.assertEqual(delays, [5])
        self.assertEqual(self.client.request.call_args.args, ("GET", "machines/m_test"))

    def test_read_does_not_retry_http_errors(self):
        self.client.request.side_effect = CloudError('{"httpStatus": 403, "code": "missing_scope"}')
        with self.assertRaisesRegex(CloudError, "missing_scope"):
            self.client.read("usage", sleep=lambda seconds: None)
        self.assertEqual(self.client.request.call_count, 1)

    def test_read_exec_does_not_retry_http_errors(self):
        self.client.request.side_effect = CloudError('{"httpStatus": 404, "code": "not_found"}')
        with self.assertRaisesRegex(CloudError, "not_found"):
            self.client.read_exec(MACHINE, ["true"], 10, sleep=lambda seconds: None)
        self.assertEqual(self.client.request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
