"solar-pro3"
# pip install openai

from openai import OpenAI # openai==1.52.2

client = OpenAI(
    api_key="up_fvxWTF1IA7tYS3vGcyk6s7cTCJi6x",
    base_url="https://api.upstage.ai/v1"
)

stream = client.chat.completions.create(
    model="solar-pro3",
    messages=[
        {
            "role": "user",
            "content": "Hi, how are you?"
        }
    ],
    stream=True,
    temperature=0.8,
    max_tokens=65536,
    reasoning_effort="medium"
)
for chunk in stream:
    if chunk.choices[0].delta.content is not None:
        print(chunk.choices[0].delta.content, end="")

# Use with stream=False
# print(stream.choices[0].message.content)

---
"kanana-o"


import base64

from openai import OpenAI

client = OpenAI(
    base_url="https://kanana-o.a2s-endpoint.kr-central-2.kakaocloud.com/v1",
    api_key="KC_IS_VzRaPJM9heTHOAWnw0lN96LkWzyE7Xm6qeauTSLL4QzfwIVhsJoSN6C4LPfnr9xF"
)

def b64_of_file(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

# Image understanding
image_b64 = b64_of_file("captioning_lion_1k.jpg")
response = client.chat.completions.create(
    model="kanana-o",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": image_b64}},
                {"type": "text", "text": "What is in this image?"}
            ]
        }
    ],
)

print(response.choices[0].message.content)

---

"openrouter"

from openai import OpenAI

client = OpenAI(
  base_url="https://openrouter.ai/api/v1",
  api_key="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",
)

# First API call with reasoning
response = client.chat.completions.create(
  model="google/gemma-4-31b-it:free",
  messages=[
          {
            "role": "user",
            "content": "How many r's are in the word 'strawberry'?"
          }
        ],
  extra_body={"reasoning": {"enabled": True}}
)

# Extract the assistant message with reasoning_details
response = response.choices[0].message

# Preserve the assistant message with reasoning_details
messages = [
  {"role": "user", "content": "How many r's are in the word 'strawberry'?"},
  {
    "role": "assistant",
    "content": response.content,
    "reasoning_details": response.reasoning_details  # Pass back unmodified
  },
  {"role": "user", "content": "Are you sure? Think carefully."}
]

# Second API call - model continues reasoning from where it left off
response2 = client.chat.completions.create(
  model="google/gemma-4-31b-it:free",
  messages=messages,
  extra_body={"reasoning": {"enabled": True}}
)