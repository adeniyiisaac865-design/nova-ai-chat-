/**
 * NOVA — Secure API Proxy (Google Gemini - FREE)
 * Netlify Function: /api/chat
 *
 * Set environment variable in Netlify:
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

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const clientIP = event.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
  if (isRateLimited(clientIP)) {
    return { statusCode: 429, headers: corsHeaders, body: JSON.stringify({ error: "Too many requests. Please wait a moment." }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "API key missing." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "messages array is required." }) };
  }

  const MAX_HISTORY = 40;
  const geminiMessages = messages
    .slice(-MAX_HISTORY)
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({
      role:  m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content).slice(0, 8000) }],
    }));

  // v1beta + gemini-2.0-flash is the correct free tier combination
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: geminiMessages,
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = data?.error?.message || "Gemini API error.";
      return { statusCode: response.status, headers: corsHeaders, body: JSON.stringify({ error: msg }) };
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from NOVA.";

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    };

  } catch (err) {
    console.error("Proxy fetch error:", err);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Failed to reach AI service. Try again." }) };
  }
};
