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
const calendlyToken = process.env.CALENDLY_API;

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

app.post("/api/schedule", async (req, res) => {
  try {
    if (!calendlyToken) {
      return res.status(500).json({ error: "Missing CALENDLY_API." });
    }

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim();
    const company = String(req.body?.company || "").trim();
    const goals = String(req.body?.goals || "").trim();
    const times = String(req.body?.times || "").trim();

    if (!name || !email || !goals || !times) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const headers = {
      Authorization: `Bearer ${calendlyToken}`,
      "Content-Type": "application/json"
    };

    const userResp = await fetch("https://api.calendly.com/users/me", { headers });
    if (!userResp.ok) {
      return res.status(500).json({ error: "Calendly user lookup failed." });
    }
    const userData = await userResp.json();
    const userUri = userData?.resource?.uri;
    if (!userUri) {
      return res.status(500).json({ error: "Calendly user not found." });
    }

    const eventsResp = await fetch(
      `https://api.calendly.com/event_types?user=${encodeURIComponent(userUri)}&active=true`,
      { headers }
    );
    if (!eventsResp.ok) {
      return res.status(500).json({ error: "Calendly event types lookup failed." });
    }
    const eventsData = await eventsResp.json();
    const eventTypes = Array.isArray(eventsData?.collection) ? eventsData.collection : [];
    if (eventTypes.length === 0) {
      return res.status(500).json({ error: "No Calendly event types found." });
    }

    const preferred = eventTypes.find((evt) =>
      String(evt?.name || "").toLowerCase().includes("intro")
    );
    const selected = preferred || eventTypes[0];
    const schedulingUrl = selected?.scheduling_url || selected?.uri || "https://calendly.com";

    const bodyLines = [
      `Name: ${name}`,
      `Email: ${email}`,
      company ? `Company: ${company}` : "Company: (not provided)",
      `Goals: ${goals}`,
      `Preferred times: ${times}`
    ];
    const subject = encodeURIComponent("AI intro call scheduling request");
    const body = encodeURIComponent(bodyLines.join("\n"));
    const mailto = `mailto:hello@rossapplied.ai?subject=${subject}&body=${body}`;

    res.json({
      schedulingUrl,
      mailto,
      summary:
        "Thanks! Use the scheduling link to pick a time. We can also follow up by email if needed."
    });
  } catch (error) {
    res.status(500).json({ error: "Schedule service error." });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
