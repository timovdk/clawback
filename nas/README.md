# Data service

Rebuilds Clawback's stop and departure data every week and publishes it for the app. Runs in
one small container (Python, plus Node for the tests). Only makes outgoing connections, so no
ports to open:

- to `gtfs.ovapi.nl` (the national timetable, ~165 MB, only downloaded when it changed),
- to Cloudflare R2 (upload `times.json` and `uov.json`, once a week).

## How it works

Every 10 minutes it checks whether the data is older than 7 days (or missing). If so:

1. download the feed (If-Modified-Since, so only when it changed) into `cache/`;
2. build `uov.json` and `times.json` into `new/`;
3. check them: `build_data.check()` (enough stops, lines and departures, both operators, a tram,
   everything in the Netherlands, departures for at least 14 days from today, not much smaller
   than last time), then **the app's own tests** (`node --test test/*.test.js`) against the new files;
4. only when both pass: move them to `current/` and upload them, **`times.json` first, `uov.json`
   second**.

When anything fails, the previous data stays (in the bucket and in `current/`), the log says why,
and it tries again after 6 hours. When only the upload failed, it retries the upload every hour.

**Consistency.** Both files carry the same `build` id. Because `times.json` goes up first, a
client never gets a new `uov.json` without the matching `times.json`; at worst it briefly has a new
`times.json` with last week's `uov.json`, which is harmless (departures are stored per date and per
platform/line/direction, and those rarely change between weeks).

## What ends up in the data folder

| Path | What |
|---|---|
| `cache/gtfs-nl.zip` | the downloaded national timetable (~165 MB) |
| `current/uov.json`, `current/times.json` | the data that's published now (~5 MB) |
| `new/` | a build being checked (removed afterwards) |
| `state.json` | when it last tried, and which build is in the bucket |

## Setup

### 1. Bucket

The domain `timovdk.nl` is already on Cloudflare (see Uplift), so only the bucket is new.

1. Cloudflare → **R2** → **Create bucket** `clawback` (location: automatic or Western Europe).
2. Bucket → Settings → **Custom Domains** → add `clawback-data.timovdk.nl`.
3. Bucket → Settings → **CORS policy**, so the app may read it:
   ```json
   [{ "AllowedOrigins": ["https://timovdk.nl", "http://localhost:8000"],
      "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
   ```
4. R2 → **Manage API tokens** → Create: permission **Object Read & Write**, only bucket
   `clawback`. Note the *Access Key ID* and *Secret Access Key* (shown once).

### 2. On the server

The NAS builds the image itself from the repository:

```sh
cd appdata/clawback
git clone https://github.com/timovdk/clawback src
cp src/nas/docker-compose.yml .
cp src/nas/.env.example .env           # fill it in; CLAWBACK_DATA = a folder on the HDDs
docker compose up -d --build
docker logs -f clawback-data           # "Data rebuilt: ... Published." after a minute or two
```

### 3. Check, then switch the app over

```sh
curl -sI https://clawback-data.timovdk.nl/uov.json | grep -i "http/\|access-control\|cache-control"
curl -s  https://clawback-data.timovdk.nl/uov.json | head -c 200
# Is the 4.4 MB times.json compressed on the way? Look for content-encoding: br or gzip
curl -sI -H 'Accept-Encoding: br, gzip' https://clawback-data.timovdk.nl/times.json | grep -i content-encoding
```

If the last command prints nothing, set `UPLOAD_GZIP=1` in `.env` and `docker compose up -d`
(the files are then uploaded gzipped; delete `state.json` or wait a week for the next upload).

Then put `https://clawback-data.timovdk.nl/` in `js/config.js` (`DATA_URL`) and push.

Update the service: `git -C src pull && docker compose up -d --build`.

## Good to know

- A build takes about 20 seconds and ~300 MB of memory.
- The container is *unhealthy* when the loop stopped, or when the data is more than 10 days old
  (the weekly refresh has been failing for a few days: check the log).
- Without the `R2_*` settings it still builds and checks, but publishes nothing.
- The app falls back to the copies in `data/` (bundled with the app) when the bucket can't be
  reached. Refresh those by hand now and then with `npm run data` and push. Departures older than
  about four weeks aren't shown at all rather than guessed.
- Free tier (Nov 2026, check Cloudflare's pricing page): 10 GB storage, 1 million writes and
  10 million reads a month. This uses a few writes a week.
- Force a rebuild: `docker compose restart` after deleting `current/uov.json` (or wait a week).
