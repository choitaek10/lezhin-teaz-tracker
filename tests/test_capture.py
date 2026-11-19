import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import scrape_teaz as st  # noqa: E402


def room(public_id, messages, likes, name="캐릭터"):
    return {
        "public_id": public_id, "name": name, "tags": ["a", "b", "c", "d"], "is_adult": True,
        "members": [{"name": name}], "scene_count": 2, "created_at": "2026-07-20T00:00:00Z",
        "entry_character": {"message_count": messages, "like_count": likes},
    }


def snapshot(at, n=5):
    return {"captured_at": at, "items": [{"message_count": 1, "like_count": 1} for _ in range(n)]}


class RoomItemTests(unittest.TestCase):
    def test_reads_entry_character_counters(self):
        item = st.room_item(room("AbC", 36428, 129, "권희서"))
        self.assertEqual(item["key"], "room:AbC")
        self.assertEqual((item["message_count"], item["like_count"]), (36428, 129))
        self.assertEqual(item["url"], "https://myteaz.io/ko/chat/r/AbC")
        self.assertEqual(len(item["tags"]), 3)

    def test_skips_missing_or_invalid_counters(self):
        bad = room("x", 1, 1)
        bad["entry_character"] = {"message_count": "10", "like_count": 1}
        self.assertIsNone(st.room_item(bad))
        self.assertIsNone(st.room_item(room("y", -1, 0)))

    def test_capture_ranks_by_messages_and_dedupes(self):
        rooms = [room(f"r{i}", i * 10, i) for i in range(6)] + [room("r5", 50, 5)]
        with mock.patch.object(st, "list_rooms", return_value=rooms):
            items = st.capture_items()
        self.assertEqual(len(items), 6)
        self.assertEqual([i["rank"] for i in items], [1, 2, 3, 4, 5, 6])
        self.assertEqual(items[0]["id"], "r5")

    def test_too_few_rooms_raises(self):
        with mock.patch.object(st, "list_rooms", return_value=[room("a", 1, 1)]):
            with self.assertRaises(ValueError):
                st.capture_items()


class ScheduleTests(unittest.TestCase):
    def test_not_due_before_morning(self):
        now = datetime(2026, 11, 19, 21, 0, tzinfo=timezone.utc)  # 06:00 KST 11/20
        self.assertFalse(st.capture_due({"snapshots": []}, now))

    def test_due_after_morning_without_capture(self):
        now = datetime(2026, 11, 19, 23, 0, tzinfo=timezone.utc)  # 08:00 KST
        history = {"snapshots": [snapshot("2026-11-19T16:00:00Z")]}  # 01:00 KST, before 07:00
        self.assertTrue(st.capture_due(history, now))

    def test_not_due_when_morning_capture_exists(self):
        now = datetime(2026, 11, 19, 23, 30, tzinfo=timezone.utc)
        history = {"snapshots": [snapshot("2026-11-19T22:05:00Z")]}
        self.assertFalse(st.capture_due(history, now))

    def test_invalid_morning_capture_does_not_block(self):
        now = datetime(2026, 11, 19, 23, 30, tzinfo=timezone.utc)
        history = {"snapshots": [snapshot("2026-11-19T22:05:00Z", n=2)]}
        self.assertTrue(st.capture_due(history, now))


class WriteTests(unittest.TestCase):
    def test_same_kst_day_replaces_and_new_day_appends(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(st, "DATA_FILE", Path(tmp) / "data" / "snapshots.json"):
                items = [st.room_item(room(f"r{i}", 10, 1)) for i in range(5)]
                history = st.load_history()
                st.write_history(history, items, now=datetime(2026, 11, 19, 22, 0, tzinfo=timezone.utc))
                st.write_history(history, items, now=datetime(2026, 11, 20, 3, 0, tzinfo=timezone.utc))
                self.assertEqual(len(history["snapshots"]), 1)
                st.write_history(history, items, now=datetime(2026, 11, 20, 22, 0, tzinfo=timezone.utc))
                saved = json.loads(st.DATA_FILE.read_text(encoding="utf-8"))
                self.assertEqual(len(saved["snapshots"]), 2)
                self.assertEqual(saved["snapshots"][-1]["totals"], {"message_count": 50, "like_count": 5, "observed_items": 5})


if __name__ == "__main__":
    unittest.main()
