#!/usr/bin/env python3
"""List every image in cats/ into cats/cats.json, so the app can pick a random one.

Static hosting can't list a folder, so run this after adding or removing cats:
    python3 scripts/build_cats.py      (or: npm run cats)

Credits (shown under the gif in the app) come from cats/credits.json:
    { "file.gif": { "author": "...", "license": "CC BY 4.0", "url": "https://..." } }
Gifs without an entry are shown without a credit line.
"""
import json
from pathlib import Path

CATS = Path(__file__).resolve().parent.parent / "cats"
EXTENSIONS = {".gif", ".webp", ".png", ".jpg", ".jpeg", ".avif"}

credits_file = CATS / "credits.json"
credits = json.loads(credits_file.read_text(encoding="utf-8")) if credits_file.exists() else {}

files = sorted(p.name for p in CATS.iterdir() if p.is_file() and p.suffix.lower() in EXTENSIONS)
entries = [{"file": f, **({"credit": credits[f]} if f in credits else {})} for f in files]
(CATS / "cats.json").write_text(json.dumps(entries, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

missing = [f for f in files if f not in credits]
print(f"cats/cats.json: {len(files)} cats" + (f" ({len(missing)} without credit: {', '.join(missing)})" if missing else ""))
for f in sorted(set(credits) - set(files)):
    print(f"note: credits.json mentions {f}, but that file isn't in cats/")
