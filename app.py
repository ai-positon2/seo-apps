"""GBP QC Agent — FastAPI web server"""

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))
load_dotenv()

from core.client_registry import ClientRegistry
from core.qc_engine import QCEngine
from utils.exporter import Exporter

STATIC_DIR = PROJECT_ROOT / "static"
STATIC_DIR.mkdir(exist_ok=True)

app = FastAPI(title="GBP QC Agent")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

registry = ClientRegistry()
_jobs: dict = {}  # job_id -> asyncio.Queue (for SSE streaming)

_LABEL_OVERRIDES = {
    "awareness_holiday": "Awareness / Holiday",
    "family_lifestyle": "Family / Lifestyle",
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _post_types(g: dict) -> list:
    tf = g.get("post_types") or g.get("post_themes") or {}
    if not tf:
        return ["General"]
    return [_LABEL_OVERRIDES.get(k, k.replace("_", " ").title()) for k in tf]


def _stages(g: dict) -> list:
    stages = [
        {"name": "Base Content Check",   "key": "base",     "description": "Review base template content against brand guidelines"},
        {"name": "Expanded Content QC",  "key": "expanded", "description": "Review location-specific content against approved base"},
    ]
    if g.get("content_generation_supported"):
        stages.append({"name": "Location Content Generator", "key": "generate", "description": "Generate ready-to-post location-specific content"})
    return stages


def _display_loc(loc: str, g: dict) -> str:
    if loc in g.get("location_format_exceptions", []):
        return loc
    fmt = g.get("brand_name_with_location_format", "[Location]")
    return fmt.replace("[Location]", loc)


def _get_g(client_id: str) -> dict:
    try:
        return registry.load_client(client_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Client '{client_id}' not found")


# ── Pydantic models ──────────────────────────────────────────────────────────

class BaseQCReq(BaseModel):
    client_id: str
    topic: str
    content: str
    post_type: str

class ExpandedQCReq(BaseModel):
    client_id: str
    base_content: str
    expanded_content: str
    post_type: str
    location: str

class GenerateReq(BaseModel):
    client_id: str
    base_content: str
    location: str
    post_type: str

class GenerateAllReq(BaseModel):
    client_id: str
    base_content: str
    post_type: str

class ExportQCReq(BaseModel):
    result: dict
    client_id: str
    stage: str
    client_name: str = ""

class ExportGeneratedReq(BaseModel):
    result: dict
    client_id: str
    location: str
    client_name: str = ""

class ExportAllReq(BaseModel):
    results: dict
    client_id: str
    post_type: str
    client_name: str = ""


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/api/clients")
async def get_clients():
    out = []
    for c in registry.list_clients():
        g = registry.load_client(c["id"])
        out.append({
            "id": c["id"],
            "name": c["name"],
            "post_types": _post_types(g),
            "stages": _stages(g),
            "locations": [_display_loc(l, g) for l in g.get("locations", [])],
            "has_generator": bool(g.get("content_generation_supported")),
        })
    return out


@app.post("/api/qc/base")
async def qc_base(req: BaseQCReq):
    g = _get_g(req.client_id)
    return await asyncio.to_thread(QCEngine(g).check_base_content, req.topic, req.content, req.post_type)


@app.post("/api/qc/expanded")
async def qc_expanded(req: ExpandedQCReq):
    g = _get_g(req.client_id)
    return await asyncio.to_thread(QCEngine(g).check_expanded_content, req.base_content, req.expanded_content, req.post_type, req.location)


@app.post("/api/generate")
async def generate_single(req: GenerateReq):
    g = _get_g(req.client_id)
    return await asyncio.to_thread(QCEngine(g).generate_location_content, req.base_content, req.location, req.post_type)


@app.post("/api/generate/all/start")
async def generate_all_start(req: GenerateAllReq):
    g = _get_g(req.client_id)
    locations = [_display_loc(l, g) for l in g.get("locations", [])]
    if not locations:
        raise HTTPException(status_code=400, detail="No locations configured for this client")

    job_id = str(uuid.uuid4())
    q: asyncio.Queue = asyncio.Queue()
    _jobs[job_id] = q
    asyncio.create_task(_run_all(job_id, req.client_id, req.base_content, req.post_type, locations))
    return {"job_id": job_id, "total": len(locations)}


async def _run_all(job_id: str, client_id: str, base_content: str, post_type: str, locations: list):
    q = _jobs.get(job_id)
    if not q:
        return
    g = registry.load_client(client_id)
    engine = QCEngine(g)
    for i, loc in enumerate(locations):
        try:
            res = await asyncio.to_thread(engine.generate_location_content, base_content, loc, post_type)
        except Exception as e:
            res = {"full_post": "", "character_count": 0, "within_limit": False,
                   "sections_included": [], "customization_notes": [f"Generation failed: {e}"]}
        await q.put({"type": "progress", "location": loc, "result": res, "index": i + 1, "total": len(locations)})
    await q.put({"type": "done"})


@app.get("/api/generate/all/stream/{job_id}")
async def generate_all_stream(job_id: str):
    q = _jobs.get(job_id)
    if not q:
        raise HTTPException(status_code=404, detail="Job not found or already completed")

    async def event_stream():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=600)
                except asyncio.TimeoutError:
                    yield 'data: {"type":"error","message":"Generation timed out"}\n\n'
                    break
                yield f"data: {json.dumps(event)}\n\n"
                if event.get("type") in ("done", "error"):
                    break
        finally:
            _jobs.pop(job_id, None)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@app.post("/api/export/qc")
async def export_qc(req: ExportQCReq):
    path = await asyncio.to_thread(Exporter().to_csv, req.result, req.client_id, req.stage, req.client_name)
    return FileResponse(path, filename=Path(path).name,
                        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.post("/api/export/generated")
async def export_generated(req: ExportGeneratedReq):
    path = await asyncio.to_thread(Exporter().to_generated_excel, req.result, req.client_id, req.location, req.client_name)
    return FileResponse(path, filename=Path(path).name,
                        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.post("/api/export/all")
async def export_all(req: ExportAllReq):
    path = await asyncio.to_thread(Exporter().to_all_locations_excel, req.results, req.client_id, req.post_type, req.client_name)
    return FileResponse(path, filename=Path(path).name,
                        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
