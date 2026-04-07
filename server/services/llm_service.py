"""Ollama LLM service for gemma4:e2b communication."""
from __future__ import annotations

import json
from typing import AsyncIterator, List, Optional, Union

import httpx

from config import OLLAMA_BASE_URL, OLLAMA_MODEL


class LLMService:
    """Communicate with Ollama API for text and vision tasks."""

    def __init__(self):
        self.base_url = OLLAMA_BASE_URL
        self.model = OLLAMA_MODEL

    async def check_health(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.base_url}/api/tags")
                return resp.status_code == 200
        except Exception:
            return False

    # ──────────────────────────────────────────────
    # Generate (Completion API)
    # ──────────────────────────────────────────────

    async def generate(
        self,
        prompt: str,
        system: str = "",
        images: Optional[List[str]] = None,
        model: Optional[str] = None,
    ) -> str:
        """Generate a non-streaming response from Ollama."""
        payload = {
            "model": model or self.model,
            "prompt": prompt,
            "stream": False,
        }
        if system:
            payload["system"] = system
        if images:
            payload["images"] = images

        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(
                f"{self.base_url}/api/generate",
                json=payload,
                timeout=300,
            )
            resp.raise_for_status()
            return resp.json().get("response", "")

    # ──────────────────────────────────────────────
    # Chat (Messages API)
    # ──────────────────────────────────────────────

    async def chat(
        self,
        messages: List[dict],
        system: str = "",
        stream: bool = False,
        **kwargs,
    ) -> Union[str, AsyncIterator[str]]:
        """Chat completion. Returns full text or async iterator."""
        payload = {
            "model": self.model,
            "messages": messages,
            "system": system,
            "stream": stream,
        }
        payload.update(kwargs)

        if stream:
            return self._stream_chat(payload)
        else:
            async with httpx.AsyncClient(timeout=300) as client:
                resp = await client.post(
                    f"{self.base_url}/api/chat",
                    json=payload,
                    timeout=300,
                )
                if resp.status_code != 200:
                    raise Exception(f"Ollama Error ({resp.status_code}): {resp.text}")
                return resp.json().get("message", {}).get("content", "")

    async def _stream_chat(self, payload: dict) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/api/chat",
                json=payload,
                timeout=300,
            ) as resp:
                async for line in resp.aiter_lines():
                    if line:
                        try:
                            data = json.loads(line)
                            token = data.get("message", {}).get("content", "")
                            if token:
                                yield token
                            if data.get("done", False):
                                return
                        except json.JSONDecodeError:
                            continue

    async def chat_stream(
        self,
        messages: List[dict],
        system: str = "",
    ) -> AsyncIterator[str]:
        """True streaming chat for SSE endpoints."""
        payload = {
            "model": self.model,
            "messages": messages,
            "system": system,
            "stream": True,
        }
        async for token in self._stream_chat(payload):
            yield token


llm_service = LLMService()
