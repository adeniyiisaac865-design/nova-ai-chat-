/**
 * NOVA — Secure API Proxy (Google Gemini - FREE)
 * Vercel Serverless Function: /api/chat
 *
 * Set environment variable in Vercel:
 *   Key:   GEMINI_API_KEY
 *   Value: your key from https://aistudio.google.com/apikey
 */

const SYSTEM_PROMPT = `You are NOVA, an intelligent and friendly AI assistant. You are helpful, knowledgeable, and precise. You format responses with markdown when helpful (especially for code, lists, and structured information). You are concise when brevity suits the question, and thorough when the topic demands depth. You never pretend to be another AI assistant.`;

const rateLimitMap = new Map();
const RATE_LIMIT   = 20;
const WINDOW_MS    = 60_000;

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Rate limit
  const clientIP = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
  if (isRateLimited(clientIP)) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  // API key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API key missing." });
  }

  // Parse body
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required." });
  }

  // Convert to Gemini format
  const MAX_HISTORY = 40;
  const geminiMessages = messages
    .slice(-MAX_HISTORY)
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({
      role:  m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content).slice(0, 8000) }],
    }));

  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: geminiMessages,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = data?.error?.message || "Gemini API error.";
      return res.status(response.status).json({ error: msg });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from NOVA.";
    return res.status(200).json({ reply });

  } catch (err) {
    console.error("Proxy fetch error:", err);
    return res.status(502).json({ error: "Failed to reach AI service. Try again." });
  }
}
  
