"""Translation router — full document translation with SSE streaming."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from models.schemas import TranslateRequest
from services.pdf_service import pdf_service
from services.translate_service import translate_service

router = APIRouter(prefix="/api", tags=["translate"])


@router.post("/translate")
async def translate_document(req: TranslateRequest):
    """Stream translated paragraphs via SSE."""
    sentences = pdf_service.get_document_sentences(req.doc_id)
    if not sentences:
        # Fallback to pages if sentences.json not available (legacy docs)
        pages = pdf_service.get_document_pages(req.doc_id)
        if not pages:
            raise HTTPException(404, "Document not found")
        
        # Simple re-processing for legacy docs (optional, or just error)
        raise HTTPException(400, "상세 좌표 정보가 없는 문서입니다. 다시 학습시켜주세요.")

    meta = pdf_service.get_document_metadata(req.doc_id)
    from_lang = meta.get("language", "en") if meta else "en"

    async def generate():
        import json
        for s_idx, s_info in enumerate(sentences):
            original = s_info["text"]
            page_num = s_info["page"]
            rects = s_info["rects"]

            if not original.strip():
                continue

            translated = await translate_service.translate_text(
                original, from_lang, req.target_lang
            )
            
            yield {
                "event": "paragraph",
                "data": json.dumps({
                    "page": page_num,
                    "index": f"s-{s_idx}",
                    "original": original,
                    "translated": translated,
                    "rects": rects
                }, ensure_ascii=False),
            }

        yield {"event": "done", "data": ""}

    return EventSourceResponse(generate())
