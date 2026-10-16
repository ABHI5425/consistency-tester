# Consistency Tester

Test an AI assistant against questions you already know the answers to. Every failure is traced to a root cause:

- **Prompt**: the facts were right, but the assistant broke a rule in its instructions
- **Retrieval**: the answer was in the knowledge base, but the assistant missed or misread it
- **Content**: the knowledge base is missing the answer or has it wrong

Paste a system prompt, a knowledge base and some test cases, then hit **Run tests**. It ships with a demo store-support bot, so you can try it right away.

## How it works

For each test case, `api/run.js` makes two calls to free models on OpenRouter:
1. **Answer**: one model plays the assistant, using your system prompt and knowledge base.
2. **Judge**: a separate model compares the reply with the expected answer and returns pass/fail, a root cause and a reason, as structured JSON.

Only model IDs ending in `:free` are ever called, so it can't spend credits. If a model is busy or unavailable, the next one in the list is tried.

## Deploy on Vercel

1. Import this repo into Vercel. No build settings are needed.
2. Add the environment variable `OPENROUTER_API_KEY` (from openrouter.ai; setting its credit limit to $0 is a good extra safeguard).
3. Optional: override the model lists with `ANSWER_MODELS` and `JUDGE_MODELS` (comma-separated, `:free` models only).

Visitors can also paste their own OpenRouter key in the app. It is sent only with their requests and never stored.
