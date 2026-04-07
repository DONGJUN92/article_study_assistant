"""Translation service using Ollama LLM for high-quality academic translation."""
from __future__ import annotations

from typing import List

from config import DEFAULT_TARGET_LANG


class TranslateService:
    """Academic text translation using Ollama LLM."""

    async def translate_text(
        self,
        text: str,
        from_lang: str = "en",
        to_lang: str = DEFAULT_TARGET_LANG,
    ) -> str:
        """Translate text using Ollama LLM for high-quality academic translation."""
        from services.llm_service import llm_service

        lang_names = {
            "ko": "Korean", "en": "English", "ja": "Japanese",
            "zh": "Chinese", "de": "German", "fr": "French",
            "es": "Spanish",
        }
        to_name = lang_names.get(to_lang, to_lang)
        from_name = lang_names.get(from_lang, from_lang)

        system_prompt = f"You are an expert translator specializing in translating {from_name} academic texts to {to_name}."
        prompt = (
            f"Please translate the following {from_name} text into natural {to_name}.\n"
            f"Provide ONLY the {to_name} translation. Do not include the original text, markdown blocks, or any explanations.\n\n"
            f"Text to translate:\n{text}"
        )
        result = await llm_service.generate(prompt=prompt, system=system_prompt, model="gemma3:1b")
        
        # Clean up possible markdown or quotes that the small model might output
        cleaned = result.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1]
            cleaned = cleaned.rsplit("```", 1)[0].strip()
        
        return cleaned

    async def translate_paragraphs(
        self,
        paragraphs: List[str],
        from_lang: str = "en",
        to_lang: str = DEFAULT_TARGET_LANG,
    ):
        """Generator that yields (index, original, translated) tuples."""
        for i, para in enumerate(paragraphs):
            if not para.strip():
                yield i, para, para
                continue
            translated = await self.translate_text(para, from_lang, to_lang)
            yield i, para, translated


translate_service = TranslateService()
