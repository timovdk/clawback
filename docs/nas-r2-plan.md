# Plan: move the weekly data refresh to the NAS and Cloudflare R2

Status: **built** (2026-11-17). Setup: `nas/README.md`. Remaining: create the bucket, start the
container, check compression, then set `DATA_URL` in `js/config.js`. Decision 4: upload order
(`times.json` first) plus a shared `build` id in both files.

## Why

The owner's other app, **Uplift** (`../uplift`, same style: static Mithril PWA on GitHub
Pages), now gets all its data from a Docker container on the owner's NAS, which uploads the
files to a public Cloudflare R2 bucket. The app reads them from there. The owner wants
Clawback to work the same way, so that:

- there are no scheduled GitHub workflows left (no weekly data commits, and GitHub's "paused
  after 60 days without commits" doesn't matter any more);
- every data job runs in one place (the NAS, one container per tool);
- GitHub only hosts the code and publishes the app on push.

## Target

| Part | Now | After |
|---|---|---|
| Weekly build (`scripts/build_data.py`, GTFS → `data/uov.json` + `data/times.json`) | GitHub Actions, Mondays 03:23 UTC, commits the files | container `clawback-data` on the NAS, weekly |
| Check before publishing | `npm test` with the new data | the same tests, in the container, before uploading |
| Where the app gets the data | `data/*.json` next to the app | R2 bucket, e.g. `https://clawback-data.timovdk.nl/`; the copies in git become the fallback |
| `deploy.yml` | data job + deploy | deploy on push only (tests, collect files, Pages) |

## Reference implementation (copy from Uplift)

All in `/Users/Kuil0004/Documents/repos/uplift`:

| File | What to take |
|---|---|
| `nas/uplift_feed.py` | `r2()` (boto3 S3 client for R2, endpoint `https://<account>.r2.cloudflarestorage.com`, region `auto`) and `publish(key, data, cache_control)`. Also the pattern "build in the background, check, keep the old data if the check fails". |
| `nas/Dockerfile` | `python:3.12-slim`, own `nas/requirements.txt` (only `boto3` is needed here), `HEALTHCHECK`, `PYTHONUNBUFFERED`, `HOME=/tmp`. |
| `nas/docker-compose.yml`, `nas/.env.example` | Built **on the NAS** from a clone in `./src` (`build: context: ./src`), `user: "${PUID}:${PGID}"`, data folder `${..._DATA}:/data`, log rotation. No image registry. |
| `nas/README.md` | Structure of the setup instructions (bucket, CORS, API token, on the server). |
| `scripts/build_stations.py`, `check()` | Example of a strict sanity check for unattended builds. |
| `js/config.js`, `js/app.js` (`dataUrls`, `fetchFirst`) | `DATA_URL` setting (empty = use `data/` next to the app); fetch from the bucket, fall back to the bundled copy. |
| `sw.js` | Cross-origin data files: stale-while-revalidate **without** the "Herladen" banner (`notify = false`), because new data isn't a new app version. |

## Decisions already made

1. **Separate container and bucket.** Container `clawback-data` in `appdata/clawback/` (the
   owner keeps one compose project per tool in `appdata/<tool>/` on NVMe; data goes on the
   HDDs). Its own R2 bucket `clawback` with custom domain `clawback-data.timovdk.nl`, its own
   API token (Object Read & Write, this bucket only). The domain `timovdk.nl` is already on
   Cloudflare.
2. **Scheduling inside the container**, no host cron: a small Python loop that builds when the
   data in the data folder is older than 7 days (and at start-up if there's none), then sleeps.
   Retry after a few hours on failure. Same idea as the monthly station refresh in Uplift.
3. **The tests stay the gate.** Run the existing `node --test test/*.test.js` against the
   freshly built files before uploading (so the image needs Node next to Python, e.g. install
   `nodejs` from Debian in the slim image, or start from a Node image and add Python). Upload
   nothing when a test fails; log why and keep the previous data.
4. **Upload order and consistency.** `uov.json` and `times.json` come from the same GTFS build
   and must match. Upload `times.json` first and `uov.json` second, or add a shared build id to
   both and have the app warn or retry on a mismatch. Pick one and document it.
5. **Cache-Control**: `public, max-age=3600` is fine for weekly data.
6. **CORS on the bucket**: `AllowedOrigins` `https://timovdk.nl` (the owner's Pages domain; check
   the actual Clawback URL) and `http://localhost:8000`; methods `GET`, `HEAD`.
7. **`UOV_USER_AGENT`** moves from the repository variable to the container's `.env`.
8. **Fallback copies in git** stay (`data/uov.json`, `data/times.json`, also in `SHELL_FILES`),
   refreshed by hand with `npm run data` now and then. The app uses them when the bucket fails.

## Things to check while building

- `times.json` is ~4.4 MB. Check that Cloudflare compresses it on the custom domain (response
  header `content-encoding: br` or `gzip`). If not, upload it gzipped with
  `ContentEncoding='gzip'`.
- `times.json` covers about four weeks. A bundled fallback that's older than that is useless
  for departures; the app should treat "too old" like "not available" (it may already).
- The service worker currently precaches `data/*.json` from the same origin. Add the bucket
  URLs as a separate cross-origin case (see Uplift's `sw.js`) and bump `VERSION`.
- Keep the GTFS download polite: the build script already uses `If-Modified-Since` and a cache.
  Put that cache in the data folder (`/data/cache`), so it survives container rebuilds.

## Work list

1. `nas/`: Dockerfile, requirements, compose, `.env.example`, the weekly loop script, README.
2. `scripts/build_data.py`: allow output and cache paths via arguments or environment
   (now fixed to `data/` and `.cache/`).
3. App: `js/config.js` with `DATA_URL`; `uov.json` and `times.json` from `DATA_URL` with
   fallback; service worker as above.
4. `.github/workflows/deploy.yml`: remove the schedule and the `refresh-data` job; keep the
   deploy on push (and `workflow_dispatch`).
5. Update `README.md` (data section, publishing, layout table).
6. Tests: the loop's decision ("is it due?", "check failed → keep old data") and the upload
   (botocore `Stubber`, as in Uplift's `test/test_feed_service.py`).
