import asyncio
import sys
import os

# Add server to path
sys.path.append(os.path.join(os.getcwd(), "server"))

from services.llm_service import llm_service

async def test():
    print("Checking health...")
    ok = await llm_service.check_health()
    print(f"Ollama Health: {ok}")
    
    print("Testing generate_with_validation...")
    res = await llm_service.generate_with_validation(
        prompt="안녕하세요, 간단한 인사를 한국어로 해보세요.",
        target_lang="ko"
    )
    print(f"Result: {res}")

if __name__ == "__main__":
    asyncio.run(test())
