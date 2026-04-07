"""Notes router — per-document study notes with AI evaluation."""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from datetime import datetime
from typing import List, Optional
from pathlib import Path

from fastapi import APIRouter, HTTPException

from models.schemas import NoteEntry, NoteEvaluateRequest
from services.llm_service import llm_service
from services.rag_service import rag_service
from services.pdf_service import pdf_service
from config import NOTES_DIR

router = APIRouter(prefix="/api", tags=["notes"])

NOTES_FILE = NOTES_DIR / "notes.json"


def _load_notes() -> List[dict]:
    if NOTES_FILE.exists():
        return json.loads(NOTES_FILE.read_text(encoding="utf-8"))
    return []


def _save_notes(entries: List[dict]):
    NOTES_FILE.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


@router.get("/notes", response_model=List[NoteEntry])
async def get_notes(doc_id: Optional[str] = None):
    entries = _load_notes()
    if doc_id:
        entries = [e for e in entries if e.get("doc_id") == doc_id]
    return entries


@router.post("/notes", response_model=NoteEntry)
async def add_note(entry: NoteEntry):
    entries = _load_notes()
    new_entry = entry.dict()
    new_entry["id"] = str(uuid.uuid4())[:8]
    new_entry["created_at"] = datetime.now().isoformat()
    entries.append(new_entry)
    _save_notes(entries)
    return NoteEntry(**new_entry)


@router.post("/notes/evaluate")
async def evaluate_note(req: NoteEvaluateRequest):
    """3-stage evaluation of a study note."""
    if not req.doc_id or not req.content:
        raise HTTPException(400, "doc_id and content required")

    target_lang = "Korean" if req.language == "ko" else "English"
    target_lang_kr = "한국어(Korean)" if target_lang == "Korean" else "영어(English)"

    try:
        # Get RAG context
        rag_results = await rag_service.query(req.doc_id, req.content, top_k=5)
        if isinstance(rag_results, list):
            rag_context = "\n\n".join([
                f"[Page {r.get('metadata', {}).get('page', '?')}] {r.get('content', r.get('text', ''))}"
                for r in rag_results
            ])
        else:
            rag_context = str(rag_results)

        # ─── Stage 1: Score ───
        p_score = f"""학생의 학습 노트를 평가하고 1~10 점수를 매기세요.

논문 내용 (RAG):
{rag_context[:4000]}

학생 노트:
"{req.content}"

[모범 답안 예시]
Input: "트랜스포머는 CNN 기반 모델이다" → 3
Input: "트랜스포머는 셀프 어텐션 메커니즘을 기반으로 한 시퀀스 모델이다" → 8

점수만 출력하세요 (1~10 사이 정수)."""

        score_str = await llm_service.generate(prompt=p_score)

        # Parse score
        score_match = re.search(r'(\d+)', score_str.strip())
        score = int(score_match.group(1)) if score_match else 5
        score = max(1, min(10, score))

        # ─── Stage 2 + 3: Detail & Summary (parallel) ───
        if score >= 7:
            p_detail = f"""학생의 학습 노트가 {score}/10점을 받았습니다 (좋은 이해력).

논문 내용 (RAG):
{rag_context[:4000]}

학생 노트: "{req.content}"

[모범 답안 예시]
"셀프 어텐션"에 대한 설명이 정확하며, 특히 시간 복잡도와 메모리 효율성의 트레이드오프를 잘 포착했습니다. [Page 3]의 핵심 기여와도 일치합니다.

2~3문장으로 어떤 부분이 잘 작성되었는지 설명하세요. {target_lang_kr}로 작성하세요. 300자 이내."""
        else:
            p_detail = f"""학생의 학습 노트가 {score}/10점을 받았습니다 (개선 필요).

논문 내용 (RAG):
{rag_context[:4000]}

학생 노트: "{req.content}"

[모범 답안 예시]
"CNN 기반"이라는 설명은 부정확합니다. [Page 2]에 따르면 "Our model relies entirely on self-attention mechanisms"로 어텐션 기반입니다. 해당 섹션을 다시 읽고 어텐션 메커니즘의 역할을 정리해 보세요.

2~3문장으로 수정이 필요한 부분과 참고할 페이지를 알려주세요. {target_lang_kr}로 작성하세요. 400자 이내."""

        p_summary = f"""학생 노트: "{req.content}"
점수: {score}/10

[모범 답안 예시]
어텐션 메커니즘의 핵심 개념은 파악했으나 계산 복잡도에 대한 이해가 부족함

한 줄 요약 (80자 이내, {target_lang_kr})으로 작성하세요."""

        # Execute detail and summary in parallel
        detail_str, summary_str = await asyncio.gather(
            llm_service.generate(prompt=p_detail),
            llm_service.generate(prompt=p_summary),
        )

        # ─── Compose final feedback ───
        score_emoji = "🟢" if score >= 7 else "🟡" if score >= 4 else "🔴"
        final_feedback = f"{score_emoji} 정확도: {score}/10\n\n{detail_str.strip()}\n\n📌 {summary_str.strip()}"

        return {"feedback": final_feedback, "score": score}

    except Exception as e:
        print(f"[Notes] Evaluate error: {e}")
        return {"feedback": f"평가 중 오류 발생: {str(e)}", "score": 0}


@router.patch("/notes/{note_id}")
async def update_note_feedback(note_id: str, data: dict):
    """Update a note's AI feedback after async evaluation."""
    entries = _load_notes()
    for e in entries:
        if e.get("id") == note_id:
            e["ai_feedback"] = data.get("ai_feedback", "")
            _save_notes(entries)
            return {"status": "updated"}
    raise HTTPException(404, "Note not found")


@router.delete("/notes/{note_id}")
async def delete_note(note_id: str):
    entries = _load_notes()
    new_entries = [e for e in entries if e.get("id") != note_id]
    if len(new_entries) == len(entries):
        raise HTTPException(404, "Note not found")
    _save_notes(new_entries)
    return {"status": "deleted", "id": note_id}


@router.delete("/notes")
async def delete_notes_by_doc(doc_id: str):
    if not doc_id:
        raise HTTPException(400, "doc_id required")
    entries = _load_notes()
    new_entries = [e for e in entries if e.get("doc_id") != doc_id]
    _save_notes(new_entries)
    return {"status": "deleted_all", "doc_id": doc_id}

