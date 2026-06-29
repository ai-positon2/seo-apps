import json
from pathlib import Path

CLIENTS_DIR = Path(__file__).parent.parent / "clients"


class ClientRegistry:
    def list_clients(self) -> list:
        clients = []
        for f in sorted(CLIENTS_DIR.glob("*.json")):
            try:
                with open(f, encoding="utf-8") as fp:
                    data = json.load(fp)
                    clients.append({
                        "id": data["client_id"],
                        "name": data["client_name"]
                    })
            except (json.JSONDecodeError, KeyError):
                continue
        return clients

    def load_client(self, client_id: str) -> dict:
        filepath = CLIENTS_DIR / f"{client_id}.json"
        if not filepath.exists():
            raise FileNotFoundError(f"No guidelines file found for client: {client_id}")
        with open(filepath, encoding="utf-8") as f:
            return json.load(f)
