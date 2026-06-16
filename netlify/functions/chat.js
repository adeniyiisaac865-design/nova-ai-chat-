/**
 * NOVA — Secure API Proxy
 * Netlify Function: /api/chat
 *
 * This function runs on Netlify's servers, never in the browser.
 * Your ANTHROPIC_API_KEY stays secret — users never see it.
 *
 * Set the environment variable in:
 *   Netlify Dashboard → Site → Environment variables → Add variable
 *   Key:   ANTHROPIC_API_KEY
 *   Value: sk-ant-api03-...
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL         = "claude-sonnet-4-6";
const MAX_TOKENS    = 1024;

const SYSTEM_PROMPT = `You are NOVA, an intelligent and friendly AI assistant. \
You are helpful, knowledgeable, and precise. You format responses with markdown \
when helpful (especially for code, lists, and structured information). You are \
concise when brevity suits the question, and thorough when the topic demands depth. \
You never pretend to be another AI assistant.`;

// Simple in-memory rate limit: max 20 requests per IP per minute
const rateLimitMap = new Map();
const RATE_LIMIT   = 20;
const WINDOW_MS    = 60_000;

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };

  if (now - entry.start > WINDOW_MS) {
    // Reset window
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT) return true;

  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
}

exports.handler = async (event) => {
  // ── CORS preflight ──
  const corsHeaders = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  // ── Only POST allowed ──
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // ── Rate limiting ──
  const clientIP = event.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
  if (isRateLimited(clientIP)) {
    return {
      statusCode: 429,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Too many requests. Please wait a moment." }),
    };
  }

  // ── API key check ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY environment variable is not set.");
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Server configuration error. API key missing." }),
    };
  }

  // ── Parse & validate body ──
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Invalid JSON body." }),
    };
  }

  const { messages } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "messages array is required." }),
    };
  }

  // Sanitize: only allow role/content, enforce string values, cap history
  const MAX_HISTORY = 40;
  const cleanMessages = messages
    .slice(-MAX_HISTORY)
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({
      role:    String(m.role),
      content: String(m.content).slice(0, 8000), // cap per message
    }));

  if (cleanMessages.length === 0) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "No valid messages provided." }),
    };
  }

  // ── Call Anthropic ──
  try {
    const response = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type":         "application/json",
        "x-api-key":            apiKey,
        "anthropic-version":    "2023-06-01",
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     SYSTEM_PROMPT,
        messages:   cleanMessages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = data?.error?.message || "Anthropic API error.";
      return {
        statusCode: response.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: msg }),
      };
    }

    const reply = data.content?.map(b => b.text || "").join("") || "";

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    };

  } catch (err) {
    console.error("Proxy fetch error:", err);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to reach AI service. Try again." }),
    };
  }
};
        
