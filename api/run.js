// Vercel serverless function: runs ONE test case.
// 1) Asks the assistant (Gemini + your system prompt + knowledge base) the question.
// 2) Asks a separate judge call to compare the reply with the expected answer
//    and label any failure as prompt / retrieval / content.

const MODELS = (process.env.GEMINI_MODEL || "gemini-flash-latest,gemini-2.5-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const API = "https://generativelanguage.googleapis.com/v1beta/models";

const JUDGE_PROMPT = `You are a strict QA reviewer for customer-facing AI assistants.
You receive: the assistant's SYSTEM PROMPT, its KNOWLEDGE BASE, a QUESTION, the EXPECTED ANSWER (written by the business owner, treat it as the truth), and the ACTUAL ANSWER the assistant gave.

Step 1 - Verdict.
PASS only if the actual answer matches the expected answer in substance (wording may differ) AND follows every rule in the system prompt.
Otherwise FAIL.

Step 2 - If FAIL, pick exactly one root cause, checking in this order:
- "content": the knowledge base does not contain the information needed for the expected answer, or contradicts it (missing, outdated or wrong). Use this even if the assistant faithfully repeated the knowledge base.
- "retrieval": the knowledge base DOES contain the right information, but the assistant missed it, misread it, or added facts that are not in it.
- "prompt": the facts are right, but the assistant broke a system-prompt rule (length, tone, format, a required step, a forbidden promise, etc.).
If PASS, category is "none".

Step 3 - reason: one short, specific sentence a product manager can act on. Quote the exact rule or knowledge-base line when relevant.

Also report kb_has_answer: true if the knowledge base contains the information needed for the expected answer.`;

const JUDGE_SCHEMA = {
  type: "OBJECT",
  properties: {
    verdict: { type: "STRING", enum: ["PASS", "FAIL"] },
    category: { type: "STRING", enum: ["none", "prompt", "retrieval", "content"] },
    kb_has_answer: { type: "BOOLEAN" },
    reason: { type: "STRING" },
  },
  required: ["verdict", "category", "kb_has_answer", "reason"],
};

class HttpError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function callGemini(key, { system, user, temperature = 0.2, schema }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature },
  };
  if (schema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = schema;
  }

  let lastError;
  for (const model of MODELS) {
    const r = await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));

    if (r.ok) {
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
      if (!text) throw new HttpError(502, "Gemini returned an empty reply (it may have been blocked by a safety filter).");
      return { text, model };
    }

    const msg = data?.error?.message || `Gemini error ${r.status}`;
    if (r.status === 404) { lastError = new HttpError(404, msg); continue; } // model not available, try next
    if (r.status === 429) {
      const delay = (data?.error?.details || []).find((d) => d.retryDelay)?.retryDelay;
      throw new HttpError(429, "Gemini free-tier rate limit hit.", delay ? parseInt(delay, 10) : 20);
    }
    if (r.status === 400 && /api key/i.test(msg)) throw new HttpError(401, "That Gemini API key isn't valid.");
    throw new HttpError(r.status >= 500 ? 502 : r.status, msg);
  }
  throw lastError || new HttpError(500, "No Gemini model available.");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const key = (req.headers["x-user-key"] || "").trim() || process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: "No Gemini API key configured. Add GEMINI_API_KEY in Vercel settings, or paste your own key in the app.",
    });
  }

  const { systemPrompt = "", knowledge = "", question = "", expected = "" } = req.body || {};
  if (!question.trim() || !expected.trim()) {
    return res.status(400).json({ error: "Each test needs a question and an expected answer." });
  }
  const total = systemPrompt.length + knowledge.length + question.length + expected.length;
  if (total > 30000) return res.status(413).json({ error: "Inputs are too long (30,000 characters max)." });

  try {
    const answer = await callGemini(key, {
      system: `${systemPrompt}\n\n=== KNOWLEDGE BASE ===\n${knowledge}`,
      user: question,
      temperature: 0.2,
    });

    const judge = await callGemini(key, {
      system: JUDGE_PROMPT,
      user: [
        `SYSTEM PROMPT:\n${systemPrompt}`,
        `KNOWLEDGE BASE:\n${knowledge}`,
        `QUESTION:\n${question}`,
        `EXPECTED ANSWER:\n${expected}`,
        `ACTUAL ANSWER:\n${answer.text}`,
      ].join("\n\n---\n\n"),
      temperature: 0,
      schema: JUDGE_SCHEMA,
    });

    let verdict;
    try { verdict = JSON.parse(judge.text); }
    catch { throw new HttpError(502, "The judge returned an unreadable result. Try running again."); }

    return res.status(200).json({
      answer: answer.text,
      verdict: verdict.verdict,
      category: verdict.verdict === "PASS" ? "none" : verdict.category,
      kbHasAnswer: verdict.kb_has_answer,
      reason: verdict.reason,
      model: answer.model,
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return res.status(status).json({ error: e.message || "Something went wrong.", retryAfter: e.retryAfter });
  }
}
