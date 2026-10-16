// Vercel serverless function: runs ONE test case, using FREE models on OpenRouter.
// 1) Asks the assistant model (your system prompt + knowledge base) the question.
// 2) Asks a separate judge model to compare the reply with the expected answer
//    and label any failure as prompt / retrieval / content.
//
// SAFETY: only model IDs ending in ":free" are ever called, so this can never
// spend OpenRouter credits.

const API = "https://openrouter.ai/api/v1/chat/completions";

const onlyFree = (list) =>
  list.split(",").map((m) => m.trim()).filter((m) => m && m.endsWith(":free"));

// The "assistant" being tested. First model is preferred; others are backups.
const ANSWER_MODELS = onlyFree(
  process.env.ANSWER_MODELS ||
    "google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3-super-120b-a12b:free"
);
// The judge. Prefer larger models that support structured JSON output.
const JUDGE_MODELS = onlyFree(
  process.env.JUDGE_MODELS ||
    "nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free"
);

const JUDGE_PROMPT = `You are a strict QA reviewer for customer-facing AI assistants.
You receive: the assistant's SYSTEM PROMPT, its KNOWLEDGE BASE, a QUESTION, the EXPECTED ANSWER (written by the business owner, treat it as the truth), and the ACTUAL ANSWER the assistant gave.

Step 1 - Verdict.
PASS only if the actual answer matches the expected answer in substance (wording may differ) AND follows every rule in the system prompt.
Otherwise FAIL.
Important: if the expected answer gives information (a fact, a yes/no, a policy) and the actual answer does not give it, that is a FAIL, even if the assistant correctly followed a fallback rule such as "say you don't know". Following the fallback is the right behaviour, but the customer still did not get the answer the business wants them to get.
Never count words yourself. Use the exact ACTUAL ANSWER WORD COUNT provided when checking length rules.

Step 2 - If FAIL, pick exactly one root cause, checking in this order:
- "content": the knowledge base does not contain the information needed for the expected answer, or contradicts it (missing, outdated or wrong). Use this even if the assistant faithfully repeated the knowledge base.
- "retrieval": the knowledge base DOES contain the right information, but the assistant missed it, misread it, or added facts that are not in it.
- "prompt": the facts are right, but the assistant broke a system-prompt rule (length, tone, format, a required step, a forbidden promise, etc.).
If PASS, category is "none".

Step 3 - reason: one short, specific sentence a product manager can act on. Quote the exact rule or knowledge-base line when relevant.

Also report kb_has_answer: true if the knowledge base contains the information needed for the expected answer.

Reply with ONLY a JSON object, no other text:
{"verdict": "PASS" or "FAIL", "category": "none" | "prompt" | "retrieval" | "content", "kb_has_answer": true or false, "reason": "..."}`;

const JUDGE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "verdict",
    strict: true,
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["PASS", "FAIL"] },
        category: { type: "string", enum: ["none", "prompt", "retrieval", "content"] },
        kb_has_answer: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["verdict", "category", "kb_has_answer", "reason"],
      additionalProperties: false,
    },
  },
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

async function callModel(key, models, { system, user, temperature, maxTokens, json }) {
  let lastError;
  let busy = null;
  for (const model of models) {
    const body = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature,
      max_tokens: maxTokens,
    };
    if (json) body.response_format = JUDGE_SCHEMA;

    let r, data;
    try {
      r = await fetch(API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": "https://consistency-tester.vercel.app",
          "X-Title": "Consistency Tester",
        },
        body: JSON.stringify(body),
      });
      data = await r.json().catch(() => ({}));
    } catch {
      lastError = new HttpError(502, "Couldn't reach OpenRouter.");
      continue;
    }

    const err = data?.error;
    const msg = err?.message || `OpenRouter error ${r.status}`;
    const code = err?.code || r.status;
    if (!r.ok || err) {
      // Shows up in Vercel > Logs so failures can be diagnosed. Never logs the key or the prompt.
      const raw = err?.metadata?.raw ? String(err.metadata.raw).slice(0, 300) : "";
      console.warn(`[model-error] ${model} status=${r.status} code=${code} msg=${msg.slice(0, 200)} ${raw}`);
    }

    if (r.ok && !err) {
      const text = (data?.choices?.[0]?.message?.content || "").trim();
      if (text) return { text, model };
      lastError = new HttpError(502, "The model returned an empty reply.");
      continue; // try a backup model
    }

    if (code === 401 || r.status === 401) throw new HttpError(401, "That OpenRouter API key isn't valid.");
    if (code === 402 || r.status === 402) throw new HttpError(402, "OpenRouter refused the request (credits). Only free models are used, so check the key's settings.");
    if (code === 429 || r.status === 429) {
      if (/per-day|per day|daily/i.test(msg)) {
        throw new HttpError(429, "Today's free request limit is used up. It resets at midnight UTC (5:30 am IST).", { daily: true });
      }
      if (/per-min|per min/i.test(msg)) {
        // Account-wide per-minute limit: trying other models would only use up more requests. Wait instead.
        throw new HttpError(429, "Free models are rate-limited right now.", { retryAfter: 30 });
      }
      busy = new HttpError(429, "Free models are rate-limited right now.", { retryAfter: 15 });
      continue; // try the next model
    }
    // 400 (e.g. JSON mode unsupported), 404 (model gone), 5xx (provider busy): try the next model
    lastError = new HttpError(502, msg);
    if (code >= 500 || r.status >= 500) busy = busy || new HttpError(429, "Free models are busy right now.", { retryAfter: 10 });
  }
  throw busy || lastError || new HttpError(500, "No free model available.");
}

function parseVerdict(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]);
    const verdict = String(v.verdict || "").toUpperCase();
    const category = String(v.category || "none").toLowerCase();
    if (!["PASS", "FAIL"].includes(verdict)) return null;
    if (!["none", "prompt", "retrieval", "content"].includes(category)) return null;
    return { verdict, category, kb_has_answer: !!v.kb_has_answer, reason: String(v.reason || "") };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const key = (req.headers["x-user-key"] || "").trim() || process.env.OPENROUTER_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: "No OpenRouter API key configured. Add OPENROUTER_API_KEY in Vercel settings, or paste your own key in the app.",
    });
  }

  const { systemPrompt = "", knowledge = "", question = "", expected = "" } = req.body || {};
  if (!question.trim() || !expected.trim()) {
    return res.status(400).json({ error: "Each test needs a question and an expected answer." });
  }
  const total = systemPrompt.length + knowledge.length + question.length + expected.length;
  if (total > 30000) return res.status(413).json({ error: "Inputs are too long (30,000 characters max)." });

  try {
    const answer = await callModel(key, ANSWER_MODELS, {
      system: `${systemPrompt}\n\n=== KNOWLEDGE BASE ===\n${knowledge}`,
      user: question,
      temperature: 0.2,
      maxTokens: 600,
    });

    const judgeInput = [
      `SYSTEM PROMPT:\n${systemPrompt}`,
      `KNOWLEDGE BASE:\n${knowledge}`,
      `QUESTION:\n${question}`,
      `EXPECTED ANSWER:\n${expected}`,
      `ACTUAL ANSWER:\n${answer.text}`,
      `ACTUAL ANSWER WORD COUNT (exact): ${answer.text.trim().split(/\s+/).length}`,
    ].join("\n\n---\n\n");

    const judge = await callModel(key, JUDGE_MODELS, {
      system: JUDGE_PROMPT,
      user: judgeInput,
      temperature: 0,
      maxTokens: 2000,
      json: true,
    });

    const verdict = parseVerdict(judge.text);
    if (!verdict) throw new HttpError(502, "The judge returned an unreadable result. Try running again.");

    return res.status(200).json({
      answer: answer.text,
      verdict: verdict.verdict,
      category: verdict.verdict === "PASS" ? "none" : verdict.category,
      kbHasAnswer: verdict.kb_has_answer,
      reason: verdict.reason,
      model: answer.model,
      judgeModel: judge.model,
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return res.status(status).json({
      error: e.message || "Something went wrong.",
      retryAfter: e.retryAfter,
      daily: e.daily || undefined,
    });
  }
}
