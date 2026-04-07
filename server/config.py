"""Article Study — Configuration"""
import os
from pathlib import Path

# ── Paths ──────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DOCUMENTS_DIR = DATA_DIR / "documents"
RAG_DIR = DATA_DIR / "rag_storage"
VOCAB_DIR = DATA_DIR / "vocabulary"
NOTES_DIR = DATA_DIR / "notes"

for d in [DATA_DIR, DOCUMENTS_DIR, RAG_DIR, VOCAB_DIR, NOTES_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ── Server ─────────────────────────────────────────────
SERVER_HOST = os.getenv("ARTICLE_STUDY_HOST", "0.0.0.0")
SERVER_PORT = int(os.getenv("ARTICLE_STUDY_PORT", "8765"))

# ── Ollama ─────────────────────────────────────────────
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma4:e2b")

# ── Embedding ──────────────────────────────────────────
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "nomic-embed-text")

# ── RAG ────────────────────────────────────────────────
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "512"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "50"))
RAG_TOP_K = int(os.getenv("RAG_TOP_K", "3"))

# ── Translation ────────────────────────────────────────
DEFAULT_TARGET_LANG = os.getenv("DEFAULT_TARGET_LANG", "ko")
