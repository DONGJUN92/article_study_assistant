"""Ollama and OpenAI LLM service for ai queries."""
from __future__ import annotations

import json
from typing import AsyncIterator, List, Optional, Union, Tuple

import httpx
from openai import AsyncOpenAI

from config import OLLAMA_BASE_URL, OLLAMA_MODEL, UPSTAGE_API_KEY, KAKAO_KANANA_API_KEY, OPENROUTER_API_KEY


class LLMService:
    """Communicate with Ollama or OpenAI APIs for text and vision tasks."""

    def __init__(self):
        self.base_url = OLLAMA_BASE_URL
        self.model = OLLAMA_MODEL
        
        # Initialize OpenAI clients with increased retries for stability
        self.solar_client = AsyncOpenAI(
            api_key=UPSTAGE_API_KEY,
            base_url="https://api.upstage.ai/v1",
            max_retries=3
        )
        self.kanana_client = AsyncOpenAI(
            api_key=KAKAO_KANANA_API_KEY,
            base_url="https://kanana-o.a2s-endpoint.kr-central-2.kakaocloud.com/v1",
            max_retries=3
        )
        self.openrouter_client = AsyncOpenAI(
            api_key=OPENROUTER_API_KEY,
            base_url="https://openrouter.ai/api/v1",
            max_retries=0  # 재시도 지옥 방지: 타임아웃 시 즉시 실패 처리
        )

    def _get_provider(self, model_name: str, openrouter_model: str) -> Tuple[Optional[AsyncOpenAI], str, dict]:
        if model_name == "solar-pro3":
            return self.solar_client, "solar-pro3", {}
        elif model_name == "kanana-o":
            return self.kanana_client, "kanana-o", {}
        elif model_name == "openrouter":
            # reasoning extra_body 제거: 무료 모델에서 추론 모드가 응답 시간을 급격히 늘림
            return self.openrouter_client, openrouter_model, {}
        return None, model_name or self.model, {}

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
        openrouter_model: str = "google/gemma-4-31b-it:free",
    ) -> str:
        """Generate a non-streaming response.
        
        For cloud providers (OpenRouter, Solar, Kanana), streams internally to prevent
        Cloudflare/proxy 524 timeout on long-running non-streaming requests.
        """
        client, target_model, extra_body = self._get_provider(model or self.model, openrouter_model)
        
        if client:
            try:
                messages = []
                if system:
                    messages.append({"role": "system", "content": system})
                if images and model == "kanana-o":
                    msg_content = [{"type": "image_url", "image_url": {"url": img}} for img in images]
                    msg_content.append({"type": "text", "text": prompt})
                    messages.append({"role": "user", "content": msg_content})
                else:
                    messages.append({"role": "user", "content": prompt})

                # 클라우드 프로바이더는 내부 스트리밍으로 토큰을 수집 후 반환.
                # Non-streaming 방식은 Cloudflare 프록시가 120초 내 응답 없으면
                # TCP를 강제 종료하므로, stream=True로 타임아웃을 우회함.
                collected = []
                stream = await client.chat.completions.create(
                    model=target_model,
                    messages=messages,
                    stream=True,
                    extra_body=extra_body if extra_body else None
                )
                async for chunk in stream:
                    if chunk.choices and chunk.choices[0].delta.content:
                        collected.append(chunk.choices[0].delta.content)
                return "".join(collected)
            except Exception as e:
                print(f"[LLMService] Error from OpenAI Provider ({target_model}): {e}")
                return f"(일시적인 API 장애가 발생했습니다. 잠시 후 다시 시도해주세요. 원인: {str(e)})"

        # Default fallback to Ollama
        try:
            payload = {
                "model": target_model,
                "prompt": prompt,
                "stream": False,
            }
            if system:
                payload["system"] = system
            if images:
                payload["images"] = images

            async with httpx.AsyncClient(timeout=300) as ollama_client:
                resp = await ollama_client.post(
                    f"{self.base_url}/api/generate",
                    json=payload,
                    timeout=300,
                )
                resp.raise_for_status()
                return resp.json().get("response", "")
        except Exception as e:
            print(f"[LLMService] Error from Ollama Provider: {e}")
            return f"(일시적인 API 장애가 발생했습니다. 잠시 후 다시 시도해주세요. 원인: {str(e)})"

    # ──────────────────────────────────────────────
    # Chat (Messages API)
    # ──────────────────────────────────────────────

    async def chat(
        self,
        messages: List[dict],
        system: str = "",
        stream: bool = False,
        model_name: Optional[str] = None,
        openrouter_model: str = "google/gemma-4-31b-it:free",
        **kwargs,
    ) -> Union[str, AsyncIterator[str]]:
        """Chat completion. Returns full text or async iterator."""
        client, target_model, extra_body = self._get_provider(model_name or self.model, openrouter_model)

        if client:
            try:
                openai_msgs = []
                if system:
                    openai_msgs.append({"role": "system", "content": system})
                openai_msgs.extend(messages)
                
                if stream:
                    return self._stream_openai_chat(client, target_model, openai_msgs, extra_body)
                else:
                    resp = await client.chat.completions.create(
                        model=target_model,
                        messages=openai_msgs,
                        stream=False,
                        extra_body=extra_body if extra_body else None
                    )
                    return resp.choices[0].message.content or ""
            except Exception as e:
                print(f"[LLMService] Error from OpenAI Provider chat ({target_model}): {e}")
                return f"(일시적인 API 장애가 발생했습니다. 잠시 후 다시 시도해주세요. 원인: {str(e)})"

        # Default fallback to Ollama
        try:
            payload = {
                "model": target_model,
                "messages": messages,
                "system": system,
                "stream": stream,
            }
            payload.update(kwargs)

            if stream:
                return self._stream_chat(payload)
            else:
                async with httpx.AsyncClient(timeout=300) as ollama_client:
                    resp = await ollama_client.post(
                        f"{self.base_url}/api/chat",
                        json=payload,
                        timeout=300,
                    )
                    if resp.status_code != 200:
                        raise Exception(f"Ollama Error ({resp.status_code}): {resp.text}")
                    return resp.json().get("message", {}).get("content", "")
        except Exception as e:
            print(f"[LLMService] Error from Ollama Provider chat: {e}")
            if stream:
                # If stream init failed, we might not be able to yield nicely, 
                # but returning an async generator that yields the error works.
                async def error_gen():
                    yield f"(일시적인 API 장애가 발생했습니다. 잠시 후 다시 시도해주세요. 원인: {str(e)})"
                return error_gen()
            return f"(일시적인 API 장애가 발생했습니다. 잠시 후 다시 시도해주세요. 원인: {str(e)})"

    async def _stream_openai_chat(self, client: AsyncOpenAI, target_model: str, messages: List[dict], extra_body: dict) -> AsyncIterator[str]:
        try:
            stream = await client.chat.completions.create(
                model=target_model,
                messages=messages,
                stream=True,
                extra_body=extra_body if extra_body else None
            )
            async for chunk in stream:
                content = chunk.choices[0].delta.content if chunk.choices and len(chunk.choices) > 0 else None
                if content:
                    yield content
        except Exception as e:
            print(f"[LLMService] stream error from OpenAI Provider: {e}")
            yield f"\n\n(스트리밍 중 끊김. 일시적인 장애가 발생했습니다. 잠시 후 다시 시도해주세요. 원인: {str(e)})"

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
        model_name: Optional[str] = None,
        openrouter_model: str = "google/gemma-4-31b-it:free",
    ) -> AsyncIterator[str]:
        """True streaming chat for SSE endpoints."""
        client, target_model, extra_body = self._get_provider(model_name or self.model, openrouter_model)
        
        if client:
            openai_msgs = []
            if system:
                openai_msgs.append({"role": "system", "content": system})
            openai_msgs.extend(messages)
            
            async for token in self._stream_openai_chat(client, target_model, openai_msgs, extra_body):
                yield token
        else:
            payload = {
                "model": target_model,
                "messages": messages,
                "system": system,
                "stream": True,
            }
            async for token in self._stream_chat(payload):
                yield token


llm_service = LLMService()
