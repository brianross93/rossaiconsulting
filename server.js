import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const apiKey = process.env.OPEN_AI_KEY;
const model = "gpt-5-mini";
const openai = apiKey ? new OpenAI({ apiKey }) : null;

app.set("trust proxy", true);
app.use(express.json({ limit: "20kb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(__dirname));

const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;

app.post("/api/chat", async (req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({ error: "Missing OPEN_AI_KEY." });
    }

    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const entry = rateLimitStore.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
    }
    entry.count += 1;
    rateLimitStore.set(ip, entry);
    if (entry.count > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: "Rate limit exceeded. Try again soon." });
    }

    const message = String(req.body?.message || "").trim();
    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }
    if (message.length > 800) {
      return res.status(400).json({ error: "Message is too long." });
    }

    const systemPrompt = [
      "You are the Ross Applied AI Consulting website assistant.",
      "Answer questions about services, pricing, and booking a free intro call.",
      "Keep replies concise, friendly, and business-focused.",
      "If asked about booking, direct them to https://rossapplied.ai/book-call/.",
      "If asked about email, provide hello@rossapplied.ai.",
      "If asked about services, list: AI Strategy Assessment, AI Integration,",
      "Custom AI Development, AI Training & Enablement, Ongoing AI Support,",
      "Talks & Presentations.",
      "If unsure, suggest booking a free intro call."
    ].join(" ");

    const response = await openai.responses.create({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: message }]
        }
      ],
    });

    const reply = response.output_text?.trim() || "Please try again.";
    res.json({ reply });
  } catch (error) {
    const message = error?.message || "Chat service error.";
    console.error("Chat error:", message);
    res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
