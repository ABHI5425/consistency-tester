# Consistency Tester

Test an AI assistant against questions you already know the answers to. Every failure is traced to a root cause:

- **Prompt**: the facts were right, but the assistant broke a rule in its instructions
- **Retrieval**: the answer was in the knowledge base, but the assistant missed or misread it
- **Content**: the knowledge base is missing the answer or has it wrong

Paste a system prompt, a knowledge base and some test cases, then hit **Run tests**. It ships with a demo store-support bot, so you can try it right away.

## How it works

For each test case, `api/run.js` makes two Gemini calls:
1. **Answer**: Gemini plays the assistant, using your system prompt and knowledge base.
2. **Judge**: a separate call compares the reply with the expected answer and returns pass/fail, a root cause and a reason, as structured JSON.

## Deploy on Vercel

1. Import this repo into Vercel. No build settings are needed.
2. Add the environment variable `GEMINI_API_KEY` (a free key from aistudio.google.com).
3. Optional: set `GEMINI_MODEL` to choose a model. The default is `gemini-flash-latest`, with `gemini-2.5-flash` as a fallback.

Visitors can also paste their own Gemini key in the app. It is sent only with their requests and never stored.
