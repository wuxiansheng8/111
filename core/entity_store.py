import json
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional


BASE_DIR = Path(__file__).parent.parent
CONFIG_DIR = BASE_DIR / "config"
DATA_FILE = CONFIG_DIR / "entities.json"


class EntityStore:
    def __init__(self):
        self._lock = threading.Lock()
        self.entities: List[Dict] = []
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        self.load()

    def load(self):
        with self._lock:
            if not DATA_FILE.exists():
                self.entities = []
                return
            try:
                payload = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            except Exception:
                self.entities = []
                return
            items = payload.get("entities") if isinstance(payload, dict) else None
            self.entities = [item for item in (items or []) if isinstance(item, dict)]

    def save(self):
        DATA_FILE.write_text(
            json.dumps(
                {"version": 1, "entities": self.entities},
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    def upsert(
        self,
        *,
        entity_id: str,
        name: str,
        entity_type: str = "",
        account_id: str,
        account_name: str = "",
        account_email: str = "",
    ) -> Dict:
        eid = str(entity_id or "").strip()
        entity_name = str(name or "").strip()
        aid = str(account_id or "").strip()
        if not eid or not entity_name or not aid:
            raise ValueError("entity_id, name and account_id are required")

        now_ts = int(time.time())
        with self._lock:
            for item in self.entities:
                if str(item.get("id") or "") == eid:
                    item.update(
                        {
                            "name": entity_name,
                            "type": str(entity_type or item.get("type") or ""),
                            "account_id": aid,
                            "account_name": str(account_name or ""),
                            "account_email": str(account_email or ""),
                            "updated_at": now_ts,
                        }
                    )
                    self.save()
                    return dict(item)

            item = {
                "id": eid,
                "name": entity_name,
                "type": str(entity_type or ""),
                "account_id": aid,
                "account_name": str(account_name or ""),
                "account_email": str(account_email or ""),
                "created_at": now_ts,
                "updated_at": now_ts,
            }
            self.entities.append(item)
            self.save()
            return dict(item)

    def find_by_name(self, name: str) -> List[Dict]:
        entity_name = str(name or "").strip()
        if not entity_name:
            return []
        with self._lock:
            return [
                dict(item)
                for item in self.entities
                if str(item.get("name") or "").strip() == entity_name
            ]

    def get_by_id(self, entity_id: str) -> Optional[Dict]:
        eid = str(entity_id or "").strip()
        if not eid:
            return None
        with self._lock:
            for item in self.entities:
                if str(item.get("id") or "").strip() == eid:
                    return dict(item)
        return None

    def list_all(self) -> List[Dict]:
        with self._lock:
            return [dict(item) for item in self.entities]

    def remove(self, entity_id: str) -> bool:
        eid = str(entity_id or "").strip()
        if not eid:
            return False
        with self._lock:
            old_len = len(self.entities)
            self.entities = [item for item in self.entities if item.get("id") != eid]
            changed = len(self.entities) != old_len
            if changed:
                self.save()
            return changed


entity_store = EntityStore()
