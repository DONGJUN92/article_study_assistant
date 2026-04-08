"""Query router — word analysis, sentence translation, and RAG chat."""
from __future__ import annotations

import asyncio
import json
import re
import time
from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from models.schemas import (
    WordRequest, WordResponse, WordExample,
    SentenceRequest, SentenceResponse,
    ChatRequest, ChatMessage,
    BriefingResponse,
)
from services.llm_service import llm_service
from services.rag_service import rag_service
from services.pdf_service import pdf_service

router = APIRouter(prefix="/api", tags=["query"])

SYSTEM_PROMPT = (
    "You are an expert research paper analysis AI. "
    "Answer the question directly based on the Deep Knowledge Context (RAG). "
    "Keep answers concise, under 300 characters, and in the user's language. "
    "Use plain text only. No greetings. No bold (**). No markdown headers."
)


@router.post("/word", response_model=WordResponse)
async def analyze_word(req: WordRequest):
    """Contextual word analysis using LLM + RAG."""
    try:
        # Get RAG context for the word
        rag_context = await rag_service.query(
            req.doc_id,
            f"The word '{req.word}' in context: {req.context}"
        )

        prompt = f"""You are an expert academic linguist. Analyze the word "{req.word}" within this paper's context.

Context sentence: {req.context}

Deep Knowledge Context (RAG):
{rag_context[:3000]}

Return your analysis as JSON with these exact keys. Here is an example:

Example input: "latent" in "The model learns latent representations."
Example output:
{{
  "contextual_meaning": "모델이 학습하는 숨겨진(잠재적) 표현 벡터를 의미",
  "academic_meaning": "직접 관찰할 수 없는 숨겨진 변수나 특성",
  "synonyms": ["hidden", "implicit"],
  "antonyms": ["observable", "explicit"],
  "pronunciation": "/ˈleɪ.tənt/",
  "examples": [{{"sentence": "The model learns latent representations of the input.", "page": null}}]
}}

Now analyze "{req.word}":
{{
  "contextual_meaning": "Korean meaning as used in this paper",
  "academic_meaning": "General academic meaning in Korean",
  "synonyms": ["synonym1", "synonym2"],
  "antonyms": ["antonym1"],
  "pronunciation": "IPA pronunciation",
  "examples": [{{"sentence": "example from context", "page": null}}]
}}

Output ONLY valid JSON, nothing else."""

        result = await llm_service.generate(
            prompt=prompt, 
            model=req.model_name, 
            openrouter_model=req.openrouter_model
        )

        # Parse JSON from response
        try:
            cleaned = result.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[1]
                cleaned = cleaned.rsplit("```", 1)[0]
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            data = {
                "contextual_meaning": result,
                "academic_meaning": "",
                "synonyms": [],
                "antonyms": [],
                "pronunciation": "",
                "examples": [],
            }

        return WordResponse(
            word=req.word,
            contextual_meaning=data.get("contextual_meaning", ""),
            academic_meaning=data.get("academic_meaning", ""),
            synonyms=data.get("synonyms", []),
            antonyms=data.get("antonyms", []),
            pronunciation=data.get("pronunciation", ""),
            examples=[
                WordExample(sentence=e.get("sentence", ""), page=e.get("page"))
                for e in data.get("examples", [])
            ],
        )
    except Exception as e:
        raise HTTPException(500, f"Word analysis failed: {e}")


@router.post("/sentence", response_model=SentenceResponse)
async def analyze_sentence(req: SentenceRequest):
    """Translate sentence + provide 3-line context summary using RAG."""
    try:
        # Get paper context
        rag_context = await rag_service.query(req.doc_id, req.sentence)

        prompt = f"""You are an expert academic translator.

Selected sentence: "{req.sentence}"

Deep Knowledge Context (RAG):
{rag_context[:3000]}

Translate and analyze. Here is an example:

Example input: "We propose a novel attention mechanism."
Example output:
{{
  "translation": "우리는 새로운 어텐션 메커니즘을 제안한다.",
  "summary": [
    "이 문장은 논문의 핵심 기여를 소개하는 부분이다.",
    "기존 어텐션 방식의 한계를 극복하려는 시도이다.",
    "이후 실험 섹션에서 이 메커니즘의 효과를 검증한다."
  ],
  "section": "Introduction"
}}

Now analyze the selected sentence:
{{
  "translation": "Korean translation",
  "summary": [
    "Contextual significance 1",
    "Contextual significance 2",
    "Contextual significance 3"
  ],
  "section": "Section name"
}}

Output ONLY valid JSON, nothing else."""

        result = await llm_service.generate(
            prompt=prompt, 
            model="gemma3:1b"
        )

        try:
            cleaned = result.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[1]
                cleaned = cleaned.rsplit("```", 1)[0]
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            data = {
                "translation": result,
                "summary": [result],
                "section": "",
            }

        return SentenceResponse(
            original=req.sentence,
            translation=data.get("translation", ""),
            summary=data.get("summary", [])[:3],
            section=data.get("section", ""),
        )
    except Exception as e:
        raise HTTPException(500, f"Sentence analysis failed: {e}")


@router.post("/chat")
async def chat_with_paper(req: ChatRequest):
    """RAG-powered chat. Returns SSE stream (stream=true) or JSON (stream=false)."""
    try:
        # Retrieve context
        rag_context = await rag_service.query(req.doc_id, req.query)
        global_text = pdf_service.get_document_text(req.doc_id) or ""
        global_context = global_text[:2000]

        print(f"[Chat] lang={getattr(req, 'language', 'N/A')}, stream={req.stream}, query='{req.query}'", flush=True)

        # Build messages
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "system", "content": f"GLOBAL PAPER OVERVIEW:\n{global_context}"},
            {"role": "system", "content": f"DEEP KNOWLEDGE CONTEXT (RAG):\n{rag_context[:4000]}"}
        ]

        history_to_keep = req.history[-11:-1] if len(req.history) > 0 else []
        for msg in history_to_keep:
            messages.append({"role": msg.role, "content": msg.content})

        messages.append({"role": "user", "content": f"QUESTION: {req.query}"})

        if not req.stream:
            # ── Non-streaming JSON mode ──
            result = await llm_service.chat(
                messages=messages, 
                system=SYSTEM_PROMPT,
                model_name=req.model_name,
                openrouter_model=req.openrouter_model
            )
            return {"answer": result}

        # ── True Streaming SSE mode ──
        async def generate():
            try:
                stream = llm_service.chat_stream(
                    messages=messages,
                    system=SYSTEM_PROMPT,
                    model_name=req.model_name,
                    openrouter_model=req.openrouter_model
                )
                async for token in stream:
                    yield {"event": "token", "data": token}
                yield {"event": "done", "data": ""}
            except Exception as e:
                print(f"[Chat] Stream error: {e}", flush=True)
                yield {"event": "token", "data": f"\n\n[오류 발생: {str(e)}]"}
                yield {"event": "done", "data": ""}

        return EventSourceResponse(generate())

    except Exception as e:
        raise HTTPException(500, f"Chat failed: {e}")


@router.get("/chat_suggestions")
async def get_chat_suggestions(doc_id: str, language: str = "ko"):
    """Return static essential questions instantly."""
    if not doc_id:
        raise HTTPException(400, "doc_id required")
    questions = [
        "이 논문의 핵심 연구 목적과 기여점은 무엇입니까?",
        "이 연구의 방법론이 기존 연구들과 어떻게 다릅니까?"
    ]
    return {"suggestions": questions}


# ──────────────────────────────────────────────
# Statistics-based Difficulty Assessment
# ──────────────────────────────────────────────

def _assess_difficulty_statistically(text: str, target_lang: str = "ko") -> str:
    """Assess reading difficulty using text statistics instead of LLM."""
    if not text or len(text) < 100:
        return "보통" if target_lang == "ko" else "Medium"

    sentences = re.split(r'[.!?]\s+', text[:5000])
    sentences = [s for s in sentences if len(s.strip()) > 5]

    if not sentences:
        return "보통" if target_lang == "ko" else "Medium"

    words_per_sentence = [len(s.split()) for s in sentences]
    avg_sentence_len = sum(words_per_sentence) / len(words_per_sentence)

    words = text[:5000].split()
    total_words = len(words) if words else 1
    tech_words = sum(1 for w in words if (
        any(c.isupper() for c in w[1:]) or
        any(c.isdigit() for c in w) or
        len(w) > 12
    ))
    tech_density = tech_words / total_words

    formula_chars = len(re.findall(r'[=∈∀∃∑∏∫≤≥±×÷∂∇αβγδεζηθλμσωΩ]', text[:5000]))
    formula_density = formula_chars / len(text[:5000])

    ref_count = len(re.findall(r'\[\d+\]|\(\w+,?\s*\d{4}\)', text[:5000]))
    ref_density = ref_count / max(len(sentences), 1)

    score = 0
    score += min(avg_sentence_len * 1.5, 30)
    score += min(tech_density * 100, 30)
    score += min(formula_density * 2000, 25)
    score += min(ref_density * 5, 15)

    if target_lang == "ko":
        if score < 20: return "쉬움"
        elif score < 40: return "보통"
        elif score < 65: return "어려움"
        else: return "전문가용"
    else:
        if score < 20: return "Easy"
        elif score < 40: return "Medium"
        elif score < 65: return "Hard"
        else: return "Expert"


def _strip_markdown(text: str) -> str:
    """Remove common markdown formatting from LLM output."""
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'__(.+?)__', r'\1', text)
    text = re.sub(r'(?<!\w)\*([^\*\n]+?)\*(?!\w)', r'\1', text)
    text = re.sub(r'`([^`]+?)`', r'\1', text)
    text = re.sub(r'^[\-\*_]{3,}\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


@router.post("/briefing", response_model=BriefingResponse)
async def generate_briefing(req: dict):
    """Generate a one-click paper briefing with a single LLM call."""
    doc_id = req.get("doc_id", "")
    language = req.get("language", "ko")
    model_name = req.get("model_name", "gemma4:e2b")
    openrouter_model = req.get("openrouter_model", "google/gemma-4-31b-it:free")
    if not doc_id:
        raise HTTPException(400, "doc_id required")

    try:
        full_text = pdf_service.get_document_text(doc_id)
        if not full_text:
            raise HTTPException(404, "Document not found")

        target_lang_kr = "한국어(Korean)" if language == "ko" else "영어(English)"

        prompt = f"""아래 논문을 분석하여 4개 섹션으로 나누어 브리핑을 작성하세요.
반드시 아래 형식의 섹션 태그를 사용하세요.

논문 내용:
{full_text[:6000]}

[모범 답안 예시]
[난이도]
어려움

[핵심 요약]
이 연구는 대규모 언어 모델의 추론 능력을 향상시키는 새로운 학습 방법을 제안한다.
핵심 기여는 chain-of-thought 프롬프팅을 자동화하여 수동 설계의 부담을 줄인 것이다.
GSM8K 벤치마크에서 기존 방법 대비 12% 높은 정확도를 달성했다.
다만 수학 이외의 추론 과제에서는 개선 폭이 제한적이었다.
향후 멀티모달 추론과 더 작은 모델로의 지식 증류가 연구 방향으로 제시되었다.

[핵심 연구 질문]
1. 기존 어텐션 메커니즘의 계산 복잡도를 어떻게 줄일 수 있는가?
2. 제안된 방법이 긴 문서에서도 효과적으로 작동하는가?
3. 사전 학습 없이도 유사한 성능을 달성할 수 있는가?

[읽기 가이드]
먼저 Section 3의 방법론을 읽고 제안된 아키텍처의 핵심 구조를 파악하세요. 이후 Table 2의 실험 결과를 기존 베이스라인과 비교하면 기여점이 명확해집니다.

[실제 논문 분석 — {target_lang_kr}로 작성]
[난이도]
"""

        t0 = time.time()
        print(f"[Briefing] Starting single LLM call...", flush=True)
        raw = await llm_service.generate(
            prompt=prompt,
            model=model_name,
            openrouter_model=openrouter_model
        )
        print(f"[Briefing] LLM done ({time.time()-t0:.1f}s)", flush=True)

        # Strip markdown formatting
        raw = _strip_markdown(raw)

        # Parse sections using markers
        def _extract(text, start, ends):
            idx = text.find(start)
            if idx == -1:
                return ""
            content = text[idx + len(start):]
            for em in ends:
                ei = content.find(em)
                if ei != -1:
                    content = content[:ei]
                    break
            return content.strip()

        difficulty = _extract(raw, "[난이도]", ["[핵심 요약]", "[핵심", "[요약]"])
        if not difficulty:
            difficulty = _assess_difficulty_statistically(full_text, target_lang=language)
        for level in ["쉬움", "보통", "어려움", "전문가용", "Easy", "Medium", "Hard", "Expert"]:
            if level in difficulty:
                difficulty = level
                break

        summary = _extract(raw, "[핵심 요약]", ["[핵심 연구 질문]", "[핵심 연구", "[연구 질문]"])
        if not summary:
            summary = raw[:500]

        questions_raw = _extract(raw, "[핵심 연구 질문]", ["[읽기 가이드]", "[읽기", "[가이드]"])
        key_questions = []
        if questions_raw:
            for line in questions_raw.split("\n"):
                line = line.strip()
                if line and line[0].isdigit() and "." in line[:3]:
                    clean = re.sub(r'^\d+\.\s*', '', line).strip()
                    if clean:
                        key_questions.append(clean)
        if not key_questions and questions_raw:
            key_questions = [l.strip() for l in questions_raw.split("\n") if l.strip()][:3]

        guide = _extract(raw, "[읽기 가이드]", ["[끝]", "[END]"])

        return BriefingResponse(
            summary=summary,
            key_questions=key_questions[:3],
            difficulty=difficulty,
            reading_guide=guide,
        )

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Briefing failed: {e}")

