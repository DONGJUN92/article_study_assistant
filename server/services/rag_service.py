"""RAG service using LightRAG for document indexing and retrieval."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import List, Optional

import httpx
from config import RAG_DIR, RAG_TOP_K, OLLAMA_BASE_URL, OLLAMA_MODEL, EMBEDDING_MODEL


class RAGService:
    """Manage LightRAG instances per document for retrieval-augmented generation."""

    def __init__(self):
        self._instances: dict = {}  # doc_id → LightRAG instance
        self._lock = asyncio.Lock()

    def _get_working_dir(self, doc_id: str) -> Path:
        wd = RAG_DIR / doc_id
        wd.mkdir(parents=True, exist_ok=True)
        return wd

    async def _get_or_create(self, doc_id: str):
        """Lazily initialise a LightRAG instance for a document."""
        if doc_id in self._instances:
            return self._instances[doc_id]

        async with self._lock:
            if doc_id in self._instances:
                return self._instances[doc_id]

            working_dir = str(self._get_working_dir(doc_id))
            
            # Default to VectorRAG for speed
            rag = VectorRAG(working_dir)
            self._instances[doc_id] = rag
            return rag

    async def ingest(self, doc_id: str, chunks: List[dict], progress_callback=None) -> bool:
        """Index document chunks into RAG."""
        try:
            rag = await self._get_or_create(doc_id)
            if hasattr(rag, "ingest"):
                await rag.ingest(chunks, progress_callback=progress_callback)
            return True
        except Exception as e:
            print(f"[RAG] Ingest error: {e}")
            return False

    async def query(self, doc_id: str, question: str, top_k: int = RAG_TOP_K) -> str:
        """Retrieve relevant context for a question."""
        try:
            rag = await self._get_or_create(doc_id)
            return await rag.query(question, top_k)
        except Exception as e:
            print(f"[RAG] Query error: {e}")
            return ""

    def is_indexed(self, doc_id: str) -> bool:
        wd = self._get_working_dir(doc_id)
        return (wd / "index_done.flag").exists()

    def mark_indexed(self, doc_id: str):
        wd = self._get_working_dir(doc_id)
        (wd / "index_done.flag").write_text("done")

    def delete_indexed(self, doc_id: str) -> bool:
        wd = self._get_working_dir(doc_id)
        if wd.exists():
            import shutil
            shutil.rmtree(wd)
            if doc_id in self._instances:
                del self._instances[doc_id]
            return True
        return False


class VectorRAG:
    """High-performance vector-based RAG using Ollama embeddings and NumPy."""

    def __init__(self, working_dir: str):
        self.working_dir = Path(working_dir)
        self.index_path = self.working_dir / "vector_index.json"
        self.data = {"chunks": [], "embeddings": []}
        self.load()

    def load(self):
        if self.index_path.exists():
            try:
                self.data = json.loads(self.index_path.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"[RAG] Failed to load index: {e}")
                pass

    def save(self):
        self.index_path.write_text(
            json.dumps(self.data, ensure_ascii=False), encoding="utf-8"
        )

    async def _get_embeddings(self, texts: List[str], model: str) -> List[List[float]]:
        """Directly call Ollama's embed API for reliability."""
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/api/embed",
                json={"model": model, "input": texts},
                timeout=120
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("embeddings", [])

    async def ingest(self, chunks: List[dict], progress_callback=None):
        """Fast bulk embedding indexing with progress tracking and time estimation."""
        import time
        
        start_time = time.time()
        texts = [c["text"] for c in chunks]
        total = len(texts)
        all_embeddings = []
        batch_size = 1 # Avoid batching bug in Ollama's nomic implementation
        
        for i in range(0, total, batch_size):
            batch_start = time.time()
            batch = texts[i:i + batch_size]
            try:
                embeddings = await self._get_embeddings(batch, EMBEDDING_MODEL)
            except Exception as e:
                print(f"[RAG] Embedding failed with model {EMBEDDING_MODEL}: {e}")
                raise
            
            all_embeddings.extend(embeddings.tolist() if hasattr(embeddings, "tolist") else embeddings)
            
            # Progress & Time Estimation
            processed = min(i + batch_size, total)
            elapsed = time.time() - start_time
            if processed > 0:
                avg_time_per_chunk = elapsed / processed
                remaining_chunks = total - processed
                est_seconds_left = avg_time_per_chunk * remaining_chunks
                
                if progress_callback:
                    await progress_callback(
                        progress=processed / total,
                        processed=processed,
                        total=total,
                        est_seconds=est_seconds_left
                    )

        self.data["chunks"] = chunks
        self.data["embeddings"] = all_embeddings
        self.save()

    async def query(self, question: str, top_k: int = 5) -> str:
        if not self.data["chunks"] or not self.data["embeddings"]:
            return ""

        import numpy as np
        
        try:
            q_emb = await self._get_embeddings([question], EMBEDDING_MODEL)
        except Exception as e:
            print(f"[RAG] Query embedding failed: {e}")
            return ""
            
        q_vec = np.array(q_emb[0])

        # Compute cosine similarities
        doc_vecs = np.array(self.data["embeddings"])
        
        # Norms
        q_norm = np.linalg.norm(q_vec)
        doc_norms = np.linalg.norm(doc_vecs, axis=1)
        
        # Similarities
        similarities = np.dot(doc_vecs, q_vec) / (doc_norms * q_norm + 1e-9)
        max_sim = np.max(similarities) if len(similarities) > 0 else 0
        
        # Top K
        top_indices = np.argsort(similarities)[-top_k:][::-1]
        
        results = []
        current_len = 0
        MAX_CONTEXT_CHARS = 8000
        
        for idx in top_indices:
            if similarities[idx] > 0.05:
                chunk_text = self.data["chunks"][idx]["text"]
                if current_len + len(chunk_text) > MAX_CONTEXT_CHARS:
                    # If single chunk is too big, truncate it, else skip
                    if not results:
                        results.append(chunk_text[:MAX_CONTEXT_CHARS])
                    break
                results.append(chunk_text)
                current_len += len(chunk_text)
        
        final_context = "\n\n---\n\n".join(results)
        print(f"[RAG Diagnostic] Query: '{question[:30]}...', Max Sim: {max_sim:.4f}, Chunks: {len(results)}, Context Len: {len(final_context)}")
        return final_context


rag_service = RAGService()
