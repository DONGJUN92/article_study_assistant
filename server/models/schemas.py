"""Pydantic schemas for API request / response models."""
from __future__ import annotations
from typing import List, Optional
from pydantic import BaseModel, Field


# ── Ingest ─────────────────────────────────────────────
class IngestRequest(BaseModel):
    pdf_url: Optional[str] = None
    pdf_data: Optional[str] = None  # base64 encoded
    filename: Optional[str] = "document.pdf"

class IngestResponse(BaseModel):
    doc_id: str
    status: str
    page_count: int
    title: Optional[str] = None

class IngestStatus(BaseModel):
    doc_id: str
    status: str  # "processing" | "complete" | "error"
    progress: float = 0.0
    message: str = ""
    estimated_seconds: float = 0.0
    total_chunks: int = 0
    processed_chunks: int = 0


# ── Word ───────────────────────────────────────────────
class WordRequest(BaseModel):
    word: str
    context: str  # surrounding sentence(s)
    doc_id: str
    model_name: Optional[str] = "gemma4:e2b"
    openrouter_model: Optional[str] = "google/gemma-4-31b-it:free"

class WordExample(BaseModel):
    sentence: str
    page: Optional[int] = None

class WordResponse(BaseModel):
    word: str
    contextual_meaning: str
    academic_meaning: str = ""
    synonyms: List[str] = []
    antonyms: List[str] = []
    pronunciation: str = ""
    examples: List[WordExample] = []


# ── Sentence ───────────────────────────────────────────
class SentenceRequest(BaseModel):
    sentence: str
    doc_id: str
    model_name: Optional[str] = "gemma4:e2b"
    openrouter_model: Optional[str] = "google/gemma-4-31b-it:free"

class SentenceResponse(BaseModel):
    original: str
    translation: str
    summary: List[str] = Field(default_factory=list, max_length=3)
    section: str = ""


# ── Chat ───────────────────────────────────────────────
class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str

class ChatRequest(BaseModel):
    query: str
    doc_id: str
    history: List[ChatMessage] = []
    language: str = "ko"
    stream: bool = True
    model_name: Optional[str] = "gemma4:e2b"
    openrouter_model: Optional[str] = "google/gemma-4-31b-it:free"

class ChatResponse(BaseModel):
    answer: str
    sources: List[dict] = []


# ── Translate ──────────────────────────────────────────
class TranslateRequest(BaseModel):
    doc_id: str
    target_lang: str = "ko"

class TranslateChunk(BaseModel):
    page: int
    original: str
    translated: str


# ── Vision ─────────────────────────────────────────────
class VisionRequest(BaseModel):
    image: str  # base64 encoded
    query: Optional[str] = ""
    doc_id: str


# ── Document ───────────────────────────────────────────
class DocumentInfo(BaseModel):
    doc_id: str
    title: str
    filename: str
    page_count: int
    ingested_at: str
    language: str = ""

class DocumentUpdate(BaseModel):
    title: Optional[str] = None


# ── Health ─────────────────────────────────────────────
class HealthResponse(BaseModel):
    status: str
    ollama: bool
    rag: bool
    version: str = "1.0.0"


# ── Briefing ───────────────────────────────────────────
class BriefingResponse(BaseModel):
    summary: str
    key_questions: List[str] = []
    difficulty: str = ""
    reading_guide: str = ""


# ── Vocabulary ─────────────────────────────────────────
class VocabEntry(BaseModel):
    word: str
    meaning: str
    context_sentence: str
    doc_id: str
    doc_title: str = ""
    added_at: str = ""
    model_name: Optional[str] = "gemma4:e2b"
    openrouter_model: Optional[str] = "google/gemma-4-31b-it:free"


# ── Notes ──────────────────────────────────────────────
class NoteEntry(BaseModel):
    id: str
    doc_id: str
    content: str
    ai_feedback: str = ""
    created_at: str = ""

class NoteEvaluateRequest(BaseModel):
    doc_id: str
    content: str
    language: str = "ko"
    model_name: Optional[str] = "gemma4:e2b"
    openrouter_model: Optional[str] = "google/gemma-4-31b-it:free"
