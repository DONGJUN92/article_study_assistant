"""AI Models router — Manages the available AI models for the extension."""
import httpx
import asyncio
from fastapi import APIRouter
from typing import List, Dict

router = APIRouter(prefix="/api", tags=["models"])

# ─────────────────────────────────────────────────────────────
# In-memory cache for OpenRouter models
# ─────────────────────────────────────────────────────────────
OPENROUTER_MODELS_CACHE = []
CACHE_LOCK = asyncio.Lock()

BUILT_IN_MODELS = ["gemma3:1b", "gemma4:e2b", "kanana-o", "solar-pro3"]

async def fetch_openrouter_free_models():
    """Fetch all :free models from OpenRouter."""
    url = "https://openrouter.ai/api/v1/models"
    # Using the standard openrouter key matching llm_service
    # If the user wants to bring their own key, they can via extension settings eventually.
    headers = {
        "Authorization": "Bearer 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"
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, headers=headers)
            if response.status_code == 200:
                data = response.json()
                fetched_models = []
                for m in data.get("data", []):
                    model_id = m.get("id", "")
                    if model_id.endswith(":free"):
                        fetched_models.append(model_id)
                return fetched_models
            else:
                print("[OpenRouter] Failed to fetch models:", response.text)
                return []
    except Exception as e:
        print("[OpenRouter] Error fetching models:", e)
        return []

@router.get("/models")
async def get_models():
    global OPENROUTER_MODELS_CACHE
    async with CACHE_LOCK:
        if not OPENROUTER_MODELS_CACHE:
            # Check OpenRouter on demand if empty (effectively startup lazy load)
            OPENROUTER_MODELS_CACHE = await fetch_openrouter_free_models()
            
    return {
        "built_in": BUILT_IN_MODELS,
        "openrouter_free": OPENROUTER_MODELS_CACHE
    }
