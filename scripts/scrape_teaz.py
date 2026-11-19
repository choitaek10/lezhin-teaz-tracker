#!/usr/bin/env python3
"""Daily, anonymous capture of public Lezhin Teaz (myteaz.io) message and like counters.

The public home page lists every room through one anonymous JSON listing
(`api.myteaz.io/chat/rooms`). Each room carries its entry character's public
`message_count` (the number shown on the home cards) and `like_count`.
One capture = one or two listing requests, nothing per character.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "dist" / "data" / "snapshots.json"
API_BASE = "https://api.myteaz.io"
SITE_BASE = "https://myteaz.io/ko"
LIST_URL = API_BASE + "/chat/rooms?limit=50&sort=newest"
KST = timezone(timedelta(hours=9), "KST")
USER_AGENT = "TeazCounter/1.0 (public-counter-research; one-daily-capture)"
MIN_ITEMS = 5
MAX_PAGES = 20


def fetch_json(url: str) -> Any:
    request = Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Origin": "https://myteaz.io",
        "Referer": SITE_BASE,
    })
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:  # nosec B310 -- fixed public HTTPS origin
                return json.loads(response.read().decode("utf-8"))
        except (URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code not in (429, 500, 502, 503, 504):
                raise
            if attempt == 2:
                raise
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError("Public listing fetch did not complete")


def list_rooms() -> list[dict[str, Any]]:
    rooms: list[dict[str, Any]] = []
    cursor = None
    for _ in range(MAX_PAGES):
        url = LIST_URL + (f"&cursor={quote(cursor)}" if cursor else "")
        page = fetch_json(url)
        if not isinstance(page, dict) or not isinstance(page.get("items"), list):
            raise ValueError("Room listing has an unexpected format")
        rooms.extend(page["items"])
        cursor = page.get("next_cursor")
        if not cursor:
            break
        time.sleep(0.5)
    return rooms


def room_item(room: dict[str, Any]) -> dict[str, Any] | None:
    entry = room.get("entry_character") or {}
    messages, likes = entry.get("message_count"), entry.get("like_count")
    if type(messages) is not int or type(likes) is not int or messages < 0 or likes < 0:
        return None
    public_id = room.get("public_id")
    if not public_id:
        return None
    return {
        "key": f"room:{public_id}",
        "id": public_id,
        "name": (room.get("name") or entry.get("name") or public_id).strip(),
        "url": f"{SITE_BASE}/chat/r/{public_id}",
        "message_count": messages,
        "like_count": likes,
        "created_at": room.get("created_at") or entry.get("created_at"),
        "tags": [tag for tag in (room.get("tags") or []) if isinstance(tag, str)][:3],
        "members": [m.get("name") for m in room.get("members") or [] if isinstance(m, dict) and m.get("name")],
        "scene_count": room.get("scene_count"),
        "is_adult": bool(room.get("is_adult")),
    }


def capture_items() -> list[dict[str, Any]]:
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for room in list_rooms():
        item = room_item(room)
        if item and item["key"] not in seen:
            seen.add(item["key"])
            items.append(item)
    if len(items) < MIN_ITEMS:
        raise ValueError(f"Only {len(items)} public counters parsed; existing data was preserved")
    items.sort(key=lambda item: (-item["message_count"], item["name"]))
    for rank, item in enumerate(items, 1):
        item["rank"] = rank
    return items


def load_history() -> dict[str, Any]:
    if not DATA_FILE.exists():
        return {"schema_version": 1, "service": "teaz", "source_url": SITE_BASE, "snapshots": []}
    history = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    if not isinstance(history, dict) or not isinstance(history.get("snapshots"), list):
        raise ValueError("Existing snapshots file has an unexpected format")
    return history


def local_date(timestamp: str) -> str:
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(KST).date().isoformat()


def valid_snapshot(snapshot: dict[str, Any]) -> bool:
    items = snapshot.get("items", [])
    return len(items) >= MIN_ITEMS and all(
        type(item.get(field)) is int and item[field] >= 0
        for item in items for field in ("message_count", "like_count")
    )


def capture_due(history: dict[str, Any], now: datetime) -> bool:
    """Keep the first valid capture after 07:00 KST, even if cron runs late."""
    morning = now.astimezone(KST).replace(hour=7, minute=0, second=0, microsecond=0)
    if now < morning:
        return False
    for snapshot in history["snapshots"]:
        captured = datetime.fromisoformat(snapshot["captured_at"].replace("Z", "+00:00"))
        if morning <= captured <= now and valid_snapshot(snapshot):
            return False
    return True


def write_history(history: dict[str, Any], items: list[dict[str, Any]], *, now: datetime | None = None) -> dict[str, Any]:
    captured = now or datetime.now(timezone.utc)
    snapshot = {
        "captured_at": captured.isoformat().replace("+00:00", "Z"),
        "captured_kst": captured.astimezone(KST).strftime("%Y-%m-%d %H:%M KST"),
        "items": items,
        "totals": {
            "message_count": sum(item["message_count"] for item in items),
            "like_count": sum(item["like_count"] for item in items),
            "observed_items": len(items),
        },
    }
    snapshots = history["snapshots"]
    if snapshots and local_date(snapshots[-1]["captured_at"]) == local_date(snapshot["captured_at"]):
        snapshots[-1] = snapshot  # one snapshot per KST day; a forced re-capture replaces it
    else:
        snapshots.append(snapshot)
    history.update({"schema_version": 1, "service": "teaz", "source_url": SITE_BASE, "updated_at": snapshot["captured_at"]})
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = DATA_FILE.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(DATA_FILE)
    return snapshot


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Capture now even before 07:00 KST or after today's capture")
    args = parser.parse_args(argv)
    try:
        history = load_history()
        if not args.force and not capture_due(history, datetime.now(timezone.utc)):
            print("Teaz capture skipped: before 07:00 KST or today's morning snapshot already exists.")
            return 0
        snapshot = write_history(history, capture_items())
    except Exception as error:  # keep existing data on any failure
        print(f"Teaz public counter capture failed: {error}", file=sys.stderr)
        return 1
    totals = snapshot["totals"]
    print(f"Captured {totals['observed_items']} Teaz rooms at {snapshot['captured_kst']}: "
          f"{totals['message_count']:,} messages, {totals['like_count']:,} likes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
