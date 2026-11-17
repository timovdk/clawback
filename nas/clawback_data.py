#!/usr/bin/env python3
"""Clawback data service: rebuild the stop and departure data weekly and publish it.

Runs in a small Docker container on a home server (see nas/README.md). In a loop it:
- checks whether the data is older than REFRESH_DAYS (or missing);
- if so, downloads the national GTFS feed (only when it changed, If-Modified-Since) into
  DATA_DIR/cache, builds uov.json and times.json into DATA_DIR/new, and checks them: first
  build_data.check(), then the app's own tests (`node --test test/*.test.js`) against the new files;
- only when both pass, moves them to DATA_DIR/current and uploads them to a public Cloudflare R2
  bucket: times.json first, uov.json second (both carry the same "build" id, see the README);
- when something fails, keeps the previous data, logs why, and tries again after RETRY_HOURS.
  When only the upload failed, it retries the upload every hour.

The app reads both files from the bucket (js/config.js, DATA_URL) and falls back to the copies
bundled with the app.

Settings (environment):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY  R2 API token (Object Read & Write, this
                    bucket only). Without them it still builds and checks, but publishes nothing.
  R2_BUCKET (clawback), UOV_USER_AGENT (identify yourself to OVapi, their usage policy),
  DATA_DIR (/data), REFRESH_DAYS (7), RETRY_HOURS (6), UPLOAD_GZIP (0: set to 1 when Cloudflare
  doesn't compress the files on the custom domain, see the README)
"""
import glob
import gzip
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / 'scripts'))

import build_data  # noqa: E402

DATA = Path(os.environ.get('DATA_DIR', '/data'))
REFRESH_S = float(os.environ.get('REFRESH_DAYS', 7)) * 86400
RETRY_S = float(os.environ.get('RETRY_HOURS', 6)) * 3600
PUBLISH_RETRY_S = 3600
TICK_S = 600
R2 = {k: os.environ.get(f'R2_{k.upper()}', '') for k in ('account_id', 'access_key_id', 'secret_access_key')}
BUCKET = os.environ.get('R2_BUCKET', 'clawback')
GZIP = os.environ.get('UPLOAD_GZIP', '0') == '1'
ALIVE = '/tmp/alive'  # touched every loop; the Docker healthcheck looks at it
CACHE_CONTROL = 'public, max-age=3600'
# Upload order: times.json first, so a client never sees a new uov.json without its times.json.
FILES = ('times.json', 'uov.json')


def log(*a):
    print(datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%SZ'), *a, flush=True)


def current_dir():
    return DATA / 'current'


def state_path():
    return DATA / 'state.json'


def load_json(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def load_state():
    return {'published': None, 'tried': 0.0, 'publish_tried': 0.0, **(load_json(state_path()) or {})}


def save_state(state):
    tmp = state_path().with_suffix('.tmp')
    tmp.write_text(json.dumps(state, indent=1), encoding='utf-8')
    tmp.replace(state_path())


def current_build():
    data = load_json(current_dir() / 'uov.json')
    return data.get('build') if data else None


def data_age_s(now=None):
    """Seconds since the current data was built (infinite when there's none)."""
    data = load_json(current_dir() / 'uov.json')
    try:
        at = datetime.fromisoformat(data['generated'])
    except (TypeError, KeyError, ValueError):
        return float('inf')
    return (now or time.time()) - at.timestamp()


def due(state, now=None):
    """Is a rebuild due? Old (or no) data, and not tried in the last RETRY_S."""
    now = now or time.time()
    return data_age_s(now) > REFRESH_S and now - state['tried'] > RETRY_S


# --- publishing ------------------------------------------------------------------------------

_client = None


def r2():
    """S3 client for R2, or None when not configured."""
    global _client
    if _client is None and all(R2.values()):
        import boto3  # only needed when publishing
        _client = boto3.client(
            's3', endpoint_url=f'https://{R2["account_id"]}.r2.cloudflarestorage.com',
            aws_access_key_id=R2['access_key_id'], aws_secret_access_key=R2['secret_access_key'],
            region_name='auto')
    return _client


def publish(key, path, client=None):
    """Upload one JSON file to the bucket. True on success (or when there's nowhere to publish)."""
    client = client or r2()
    if not client:
        return True
    body = Path(path).read_bytes()
    extra = {}
    if GZIP:
        body = gzip.compress(body, 9)
        extra['ContentEncoding'] = 'gzip'
    try:
        client.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType='application/json',
                          CacheControl=CACHE_CONTROL, **extra)
    except Exception as e:
        log(f'Publishing {key} failed: {e}')
        return False
    return True


def publish_current(state, client=None):
    """Upload the current files (times.json, then uov.json). Records the build once both are up."""
    state['publish_tried'] = time.time()
    for name in FILES:
        if not publish(name, current_dir() / name, client):
            save_state(state)
            return False
    state['published'] = current_build()
    save_state(state)
    return True


# --- building --------------------------------------------------------------------------------

def run_tests(data_dir):
    """The app's own tests against the files in `data_dir`. Returns (ok, last lines of output)."""
    files = sorted(glob.glob(str(ROOT / 'test' / '*.test.js')))
    if not files:
        return False, 'no tests found'
    env = {**os.environ, 'CLAWBACK_DATA_DIR': str(data_dir)}
    try:
        r = subprocess.run(['node', '--test', *files], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    out = (r.stdout + r.stderr).strip().splitlines()
    failed = [l for l in out if l.startswith('not ok')]
    return r.returncode == 0, '; '.join(failed[:5]) or '\n'.join(out[-5:])


def refresh(state, client=None, tests=run_tests):
    """Rebuild, check and (when it passes) publish. Returns True when new data was taken into use."""
    state['tried'] = time.time()
    save_state(state)
    new = DATA / 'new'
    shutil.rmtree(new, ignore_errors=True)
    try:
        cache = DATA / 'cache' / 'gtfs-nl.zip'
        build_data.download(cache)
        data, times = build_data.build(cache)
        problems = build_data.check(data, times, load_json(current_dir() / 'uov.json'))
        if not problems:
            build_data.write(data, times, new)
            ok, why = tests(new)
            if not ok:
                problems = [f'tests failed: {why}']
    except Exception as e:  # a download or format problem: try again later
        log(f'Rebuilding failed, keeping the previous data: {e}')
        return False
    if problems:
        log('New data NOT used, it looks wrong: ' + '; '.join(problems))
        return False

    current_dir().mkdir(parents=True, exist_ok=True)
    for name in FILES:
        os.replace(new / name, current_dir() / name)
    shutil.rmtree(new, ignore_errors=True)
    ok = publish_current(state, client)
    log(f'Data rebuilt: {build_data.summary(data, times)}. '
        f'{"Published" if ok and (client or r2()) else "Not published (no R2 settings)" if ok else "Upload failed, retrying hourly"}.')
    return True


# --- main loop -------------------------------------------------------------------------------

def touch(path):
    with open(path, 'a'):
        os.utime(path)


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # docker stop: exit cleanly
    DATA.mkdir(parents=True, exist_ok=True)
    state = load_state()
    age = data_age_s()
    log(f'Starting: data {"missing" if age == float("inf") else f"{age / 86400:.1f} days old"}, publishing to '
        f'{f"R2 bucket {BUCKET}" if all(R2.values()) else "nowhere (no R2_* settings)"}.')
    while True:
        touch(ALIVE)
        if due(state):
            refresh(state)
        elif current_build() and state['published'] != current_build() and r2() \
                and time.time() - state['publish_tried'] > PUBLISH_RETRY_S:
            if publish_current(state):
                log('Published the data that failed to upload earlier.')
        time.sleep(TICK_S)


if __name__ == '__main__':
    main()
