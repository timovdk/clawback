# Clawback

A small web app (PWA) for quickly filing an accessibility complaint with U-OV, the public
transport in Utrecht: broken wheelchair seatbelts, ramps that don't work, drivers who don't
help or who behave in an ableist way.

You pick the stop, the line and the issue in a few taps, and Clawback opens **U-OV's own
complaint form** with every field already filled in. You check it, send it, and confirm through
the e-mail U-OV sends you. In a hurry? Save it and finish it later. A cat keeps you company.

> Clawback is an independent tool. It is not made by or on behalf of U-OV, Transdev or Keolis.

## Use it

Open the site on your phone and add it to your home screen (Safari: share → "Zet op
beginscherm"; Chrome: "Installeren"). It works offline; only sending needs a connection.
Everything you enter stays on your device.

## Develop

```sh
npm run serve   # local server on http://localhost:8000
npm test        # unit tests (node --test)
npm run data    # refresh data/uov.json from the national GTFS feed (~165 MB download, cached)
npm run cats    # update cats/cats.json after adding or removing cat gifs
```

For `npm run data`, set `UOV_USER_AGENT` to identify yourself to OVapi (their usage policy),
e.g. `UOV_USER_AGENT="clawback/1.0 (contact)" npm run data`.

The service worker serves cached files first, so changes appear one reload later. In Chrome
DevTools → Application → Service workers, tick "Update on reload" while developing. Bump
`VERSION` in `sw.js` when the list of precached files changes.

### Layout

| Path | What |
|---|---|
| `index.html`, `style.css` | page and styles (light/dark via `data-theme`) |
| `js/app.js` | the Mithril UI |
| `js/config.js` | U-OV form field IDs and the issue buttons with their texts |
| `js/messages.js` | what the cat mascot says |
| `js/mascot.js` | the mascot drawing and its coats |
| `js/lib.js` | pure logic (form link, description, stops), tested in `test/` |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA: offline cache and home screen icon |
| `data/uov.json` | stops and lines, built by `scripts/build_data.py` |
| `cats/` | gifs shown after sending; credits in `cats/credits.json` |
| `tools/prefill-test.html` | check the form prefill after U-OV changes their form |

### Publishing

`.github/workflows/deploy.yml` publishes the app to GitHub Pages on every push to `main`, and
refreshes the timetable data on the 1st of every month (or by hand: Actions → "Update data and
deploy" → Run workflow). The tests run before every publish; if they fail, nothing is published
and GitHub e-mails you.

Once: Settings → Pages → Source: **GitHub Actions**. Optionally add a repository variable
`UOV_USER_AGENT` with a way for OVapi to reach you.

Saved drafts and the log live on the phone and aren't touched by a data update. They store plain
text (line, direction, stop name), so they stay valid; a draft whose stop has disappeared from the
data keeps the saved stop and shows a short note.

### If U-OV changes their form

Save the form page from your browser, read the new field IDs and dropdown values from it, update
`js/config.js`, and check with `tools/prefill-test.html`. The saved page doesn't need to stay in
the repo.

## Licence

Clawback is licensed under the [EUPL-1.2](LICENSE) (European Union Public Licence), an official
EU open-source licence, available in all EU languages
([Dutch text](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12)).
You may use, change and share it; changed versions you share or offer as a service must stay
open source under the EUPL (or a compatible licence listed in its appendix).

Copyright (c) 2026 Timo van der Kuil.
Licensed under the EUPL.

Third-party parts keep their own licences:

- `vendor/mithril.min.js`: MIT, see `vendor/mithril.LICENSE`
- `cats/*`: per file, see `cats/credits.json` (Creative Commons / MIT)
- `data/uov.json`: derived from CC0 open data (NDOV Loket, via OVapi)
