"""PDF ingest router — upload, parse, and RAG-index documents."""
from __future__ import annotations

import asyncio
from fastapi import APIRouter, HTTPException, BackgroundTasks

from models.schemas import IngestRequest, IngestResponse, IngestStatus, DocumentInfo, DocumentUpdate
from services.pdf_service import pdf_service
from services.rag_service import rag_service

router = APIRouter(prefix="/api", tags=["ingest"])

# In-memory progress tracker
_progress: dict[str, IngestStatus] = {}


async def _ingest_background(doc_id: str, chunks: list):
    """Background task: index chunks into RAG with live updates."""
    _progress[doc_id] = IngestStatus(
        doc_id=doc_id, status="processing", progress=0.0,
        message="Initializing Fast Vector Indexing...",
        total_chunks=len(chunks)
    )

    async def on_progress(progress, processed, total, est_seconds):
        _progress[doc_id] = IngestStatus(
            doc_id=doc_id,
            status="processing",
            progress=progress,
            processed_chunks=processed,
            total_chunks=total,
            estimated_seconds=est_seconds,
            message=f"Learning... {processed}/{total} (Est. {int(est_seconds)}s left)"
        )

    try:
        success = await rag_service.ingest(doc_id, chunks, progress_callback=on_progress)
        if success:
            rag_service.mark_indexed(doc_id)
            _progress[doc_id] = IngestStatus(
                doc_id=doc_id, status="complete", progress=1.0,
                message="Learning complete!"
            )
        else:
            _progress[doc_id] = IngestStatus(
                doc_id=doc_id, status="error", progress=0.0,
                message="RAG indexing failed"
            )
    except Exception as e:
        _progress[doc_id] = IngestStatus(
            doc_id=doc_id, status="error", progress=0.0,
            message=str(e)
        )


@router.post("/ingest", response_model=IngestResponse)
async def ingest_pdf(req: IngestRequest, bg: BackgroundTasks):
    """Upload/parse a PDF and start RAG indexing."""
    try:
        raw_bytes = b""
        filename = "doc.pdf"
        
        if req.pdf_data:
            import base64
            raw_bytes = base64.b64decode(req.pdf_data)
            filename = req.filename or "doc.pdf"
        elif req.pdf_url:
            from pathlib import Path
            filename = req.filename or req.pdf_url.split("/")[-1].split("?")[0]
            if req.pdf_url.startswith("file:///"):
                import urllib.parse
                path_part = req.pdf_url.replace("file:///", "")
                local_path = urllib.parse.unquote(path_part)
                if len(local_path) > 2 and local_path[1] == ':' and local_path[0] == '/':
                   local_path = local_path[1:]
                
                print(f"[INGEST] Attempting local path: {local_path}")
                try:
                    raw_bytes = Path(local_path).read_bytes()
                except Exception as e:
                    print(f"[INGEST] Local file read failed: {e}")
                    raise HTTPException(400, f"로컬 파일을 읽을 수 없습니다. 경로가 올바른지 확인해주세요. ({e})")
            else:
                import httpx
                try:
                    resp = httpx.get(req.pdf_url, follow_redirects=True, timeout=60)
                    resp.raise_for_status()
                    raw_bytes = resp.content
                except Exception as e:
                    print(f"[INGEST] Remote download failed: {e}")
                    raise HTTPException(400, f"논문 다운로드 실패: {e}")
        else:
            raise HTTPException(400, "Either pdf_url or pdf_data required")

        doc_id = pdf_service.generate_doc_id(raw_bytes)

        # Check if already indexed BEFORE doing full extraction
        if rag_service.is_indexed(doc_id):
            meta = pdf_service.get_document_metadata(doc_id)
            _progress[doc_id] = IngestStatus(
                doc_id=doc_id, status="complete", progress=1.0,
                message="Already indexed"
            )
            return IngestResponse(
                doc_id=doc_id,
                status="already_indexed",
                page_count=meta.get("page_count", 0) if meta else 0,
                title=meta.get("title") if meta else filename,
            )

        # Proceed with expensive parsing
        result = pdf_service.extract_from_bytes(raw_bytes, filename)

        # Initialize progress
        _progress[doc_id] = IngestStatus(
            doc_id=doc_id, status="processing", progress=0.1,
            message="PDF parsed, starting RAG indexing..."
        )

        # Start background RAG indexing
        bg.add_task(_ingest_background, doc_id, result["chunks"])

        return IngestResponse(
            doc_id=doc_id,
            status="processing",
            page_count=result["page_count"],
            title=result.get("title"),
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Ingest failed: {e}")


@router.get("/ingest/{doc_id}/status", response_model=IngestStatus)
async def get_ingest_status(doc_id: str):
    if doc_id in _progress:
        return _progress[doc_id]
    if rag_service.is_indexed(doc_id):
        return IngestStatus(
            doc_id=doc_id, status="complete", progress=1.0,
            message="Already indexed"
        )
    raise HTTPException(404, "Document not found")


@router.get("/documents", response_model=list[DocumentInfo])
async def list_documents():
    docs = pdf_service.list_documents()
    return [
        DocumentInfo(
            doc_id=d["doc_id"],
            title=d.get("title", ""),
            filename=d.get("filename", ""),
            page_count=d.get("page_count", 0),
            ingested_at=d.get("ingested_at", ""),
            language=d.get("language", ""),
        )
        for d in docs
    ]


from fastapi.responses import FileResponse, Response

@router.get("/documents/{doc_id}/pdf")
async def get_document_pdf(doc_id: str):
    pdf_path = pdf_service.get_document_pdf_path(doc_id)
    if pdf_path and pdf_path.exists():
        return FileResponse(pdf_path, media_type="application/pdf")
    raise HTTPException(404, "PDF file not found")


@router.patch("/documents/{doc_id}")
async def update_document(doc_id: str, req: DocumentUpdate):
    """Update document metadata (e.g. rename title)."""
    updates = req.model_dump(exclude_unset=True)
    if not updates or not updates.get("title"):
        raise HTTPException(400, "Title is required for update")
    
    success = pdf_service.update_metadata(doc_id, updates)
    if success:
        return {"status": "updated", "doc_id": doc_id}
    raise HTTPException(404, "Document not found")


@router.delete("/documents/{doc_id}")
async def delete_document(doc_id: str):
    success_pdf = pdf_service.delete_document(doc_id)
    success_rag = rag_service.delete_indexed(doc_id)
    if success_pdf or success_rag:
        _progress.pop(doc_id, None)
        return {"status": "deleted"}
    raise HTTPException(404, "Document not found")
