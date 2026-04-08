"""Vocabulary router — smart word book with spaced repetition."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException

from models.schemas import VocabEntry
from config import VOCAB_DIR
from services.llm_service import llm_service

router = APIRouter(prefix="/api", tags=["vocabulary"])

VOCAB_FILE = VOCAB_DIR / "vocabulary.json"


def _load_vocab() -> List[dict]:
    if VOCAB_FILE.exists():
        return json.loads(VOCAB_FILE.read_text(encoding="utf-8"))
    return []


def _save_vocab(entries: List[dict]):
    VOCAB_FILE.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8"
    )


@router.get("/vocabulary", response_model=List[VocabEntry])
async def get_vocabulary(doc_id: Optional[str] = None):
    entries = _load_vocab()
    if doc_id:
        return [e for e in entries if e.get("doc_id") == doc_id]
    return entries


from fastapi import BackgroundTasks

async def _bg_generate_vocab(word: str, context: str, doc_id: str, model_name: str = "gemma4:e2b", openrouter_model: str = "google/gemma-4-31b-it:free"):
    try:
        prompt = f"""학술 단어의 의미를 한국어로 분석하세요.

단어: "{word}"
문맥: "{context or 'None'}"

[모범 답안 예시]
단어: "latent"
문맥: "The model learns latent representations."

1. 일반적 의미: 숨겨진, 잠재적인. 겉으로 드러나지 않는 상태를 의미.
2. 문맥적 의미: 모델이 학습하는 관찰 불가능한 내부 표현 벡터를 지칭.

[실제 분석]
1. 일반적 의미: """

        result = await llm_service.generate(
            prompt=prompt,
            model=model_name,
            openrouter_model=openrouter_model
        )
        
        import re
        text = result.strip()
        text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
        text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
        text = re.sub(r'__(.+?)__', r'\1', text)
        text = re.sub(r'(?<!\w)\*([^\*\n]+?)\*(?!\w)', r'\1', text)
        text = re.sub(r'`([^`]+?)`', r'\1', text)
        text = re.sub(r'^[\-\*_]{3,}\s*$', '', text, flags=re.MULTILINE)
        text = re.sub(r'\n{3,}', '\n\n', text)
        final_meaning = text.strip()
        
    except Exception as e:
        print(f"[Vocab] Background gen error: {e}")
        final_meaning = f"(의미 자동 생성 실패: {e})"

    # Update the storage
    entries = _load_vocab()
    for e in entries:
        if e["word"].lower() == word.lower() and e.get("doc_id") == doc_id:
            e["meaning"] = final_meaning
            _save_vocab(entries)
            break

@router.post("/vocabulary", response_model=VocabEntry)
async def add_vocabulary(entry: VocabEntry, background_tasks: BackgroundTasks):
    entries = _load_vocab()

    # Check for duplicate
    for e in entries:
        if e["word"].lower() == entry.word.lower() and e["doc_id"] == entry.doc_id:
            return VocabEntry(**e)

    needs_llm = not entry.meaning
    if needs_llm:
        entry.meaning = "⏳ AI 분석 중..."

    new_entry = entry.model_dump()
    new_entry["added_at"] = datetime.now(timezone.utc).isoformat()

    entries.append(new_entry)
    _save_vocab(entries)

    if needs_llm:
        background_tasks.add_task(_bg_generate_vocab, entry.word, entry.context_sentence, entry.doc_id, entry.model_name, entry.openrouter_model)

    return VocabEntry(**new_entry)


@router.delete("/vocabulary/{word}")
async def delete_word(word: str, doc_id: Optional[str] = None):
    entries = _load_vocab()
    if doc_id:
        new_entries = [e for e in entries if not (e["word"].lower() == word.lower() and e.get("doc_id") == doc_id)]
    else:
        new_entries = [e for e in entries if e["word"].lower() != word.lower()]

    if len(new_entries) == len(entries):
        raise HTTPException(404, "Word not found")
    _save_vocab(new_entries)
    return {"status": "deleted"}


@router.delete("/vocabulary/document/{doc_id}")
async def delete_document_vocab(doc_id: str):
    entries = _load_vocab()
    new_entries = [e for e in entries if e.get("doc_id") != doc_id]
    _save_vocab(new_entries)
    return {"status": "deleted"}


@router.get("/vocabulary/due")
async def get_due_reviews():
    """Get words due for review."""
    entries = _load_vocab()
    now = datetime.now(timezone.utc).isoformat()
    due = [e for e in entries if e.get("next_review", "") <= now]
    return due
