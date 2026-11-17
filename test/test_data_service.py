"""Tests for the NAS data service (nas/clawback_data.py). The upload tests need boto3
(nas/requirements.txt) and are skipped without it; the rest only uses the standard library.
Run with: python3 -m unittest discover -s test -p 'test_*.py'"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'nas'))
import clawback_data as svc  # noqa: E402

HAVE_BOTO = importlib.util.find_spec('boto3') is not None


def fake_build(generated=None, build='b-new'):
    generated = generated or datetime.now(timezone.utc).isoformat(timespec='seconds')
    data = {'generated': generated, 'build': build, 'routes': {}, 'stops': []}
    times = {'build': build, 'dates': ['20261117'], 'k': {}}
    return data, times


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = (svc.DATA, svc.build_data.download, svc.build_data.build, svc.build_data.check)
        svc.DATA = Path(self.tmp.name)
        svc.build_data.download = lambda cache: None

    def tearDown(self):
        svc.DATA, svc.build_data.download, svc.build_data.build, svc.build_data.check = self.saved
        self.tmp.cleanup()

    def put_current(self, days_old, build='b-old'):
        generated = (datetime.now(timezone.utc) - timedelta(days=days_old)).isoformat(timespec='seconds')
        data, times = fake_build(generated, build)
        svc.build_data.write(data, times, svc.current_dir())

    # --- is it due? ---

    def test_due_without_data(self):
        self.assertTrue(svc.due(svc.load_state()))

    def test_not_due_with_fresh_data(self):
        self.put_current(days_old=2)
        self.assertFalse(svc.due(svc.load_state()))

    def test_due_with_old_data_but_not_right_after_a_failed_try(self):
        self.put_current(days_old=8)
        state = svc.load_state()
        self.assertTrue(svc.due(state))
        state['tried'] = time.time() - 3600  # failed an hour ago
        self.assertFalse(svc.due(state))
        state['tried'] = time.time() - 7 * 3600
        self.assertTrue(svc.due(state))

    # --- refresh ---

    def test_failed_check_keeps_the_old_data(self):
        self.put_current(days_old=8)
        svc.build_data.build = lambda cache: fake_build()
        svc.build_data.check = lambda data, times, previous: ['only 3 stops']
        self.assertFalse(svc.refresh(svc.load_state(), tests=lambda d: (True, '')))
        self.assertEqual(svc.current_build(), 'b-old')

    def test_failed_tests_keep_the_old_data(self):
        self.put_current(days_old=8)
        svc.build_data.build = lambda cache: fake_build()
        svc.build_data.check = lambda data, times, previous: []
        self.assertFalse(svc.refresh(svc.load_state(), tests=lambda d: (False, 'not ok 3 - departures')))
        self.assertEqual(svc.current_build(), 'b-old')
        self.assertFalse((svc.DATA / 'current' / 'new').exists())

    def test_download_error_keeps_the_old_data(self):
        self.put_current(days_old=8)

        def broken(cache):
            raise OSError('feed down')
        svc.build_data.download = broken
        self.assertFalse(svc.refresh(svc.load_state(), tests=lambda d: (True, '')))
        self.assertEqual(svc.current_build(), 'b-old')

    def test_good_build_replaces_the_data_and_tests_see_the_new_files(self):
        self.put_current(days_old=8)
        svc.build_data.build = lambda cache: fake_build()
        svc.build_data.check = lambda data, times, previous: []
        seen = {}

        def tests(d):
            seen['build'] = json.loads((Path(d) / 'uov.json').read_text())['build']
            return True, ''
        state = svc.load_state()
        self.assertTrue(svc.refresh(state, tests=tests))
        self.assertEqual(seen['build'], 'b-new')
        self.assertEqual(svc.current_build(), 'b-new')
        self.assertFalse(svc.due(state))

    def test_the_real_tests_pass_on_the_bundled_data(self):
        if not os.path.exists(ROOT / 'data' / 'uov.json'):
            self.skipTest('no bundled data')
        ok, why = svc.run_tests(ROOT / 'data')
        self.assertTrue(ok, why)


@unittest.skipUnless(HAVE_BOTO, 'needs boto3 (nas/requirements.txt)')
class PublishTest(unittest.TestCase):
    def setUp(self):
        import boto3
        from botocore.stub import Stubber
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = svc.DATA
        svc.DATA = Path(self.tmp.name)
        data, times = fake_build(build='b1')
        svc.build_data.write(data, times, svc.current_dir())
        self.client = boto3.client('s3', endpoint_url='https://acc.r2.cloudflarestorage.com',
                                   aws_access_key_id='k', aws_secret_access_key='s', region_name='auto')
        self.stub = Stubber(self.client)

    def tearDown(self):
        svc.DATA = self.saved
        self.tmp.cleanup()

    def expect_put(self, key):
        self.stub.add_response('put_object', {}, {
            'Bucket': 'clawback', 'Key': key, 'ContentType': 'application/json',
            'CacheControl': 'public, max-age=3600',
            'Body': (svc.current_dir() / key).read_bytes()})

    def test_uploads_times_first_then_uov(self):
        self.expect_put('times.json')
        self.expect_put('uov.json')
        state = svc.load_state()
        with self.stub:
            self.assertTrue(svc.publish_current(state, self.client))
        self.stub.assert_no_pending_responses()
        self.assertEqual(state['published'], 'b1')

    def test_failed_upload_is_retried_later(self):
        self.expect_put('times.json')
        self.stub.add_client_error('put_object', 'AccessDenied', http_status_code=403)
        state = svc.load_state()
        with self.stub:
            self.assertFalse(svc.publish_current(state, self.client))
        self.assertIsNone(state['published'])
        self.assertEqual(svc.load_state()['published'], None)


if __name__ == '__main__':
    unittest.main()
