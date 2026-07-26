import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const apiKey = process.env.OPEN_AI_KEY;
const model = "gpt-5-mini";
const openai = apiKey ? new OpenAI({ apiKey }) : null;
const calendlyToken = process.env.CALENDLY_API;
const calendlySchedulingUrl = process.env.CALENDLY_SCHEDULING_URL;
const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL || "hello@rossapplied.ai";

async function sendResendEmail({ to, subject, html, text }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendApiKey}`,
      "Idempotency-Key": crypto.randomUUID()
    },
    body: JSON.stringify({
      from: resendFromEmail,
      to,
      subject,
      html,
      text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend error: ${response.status} ${errorText}`);
  }
}

app.set("trust proxy", true);
app.use(express.json({ limit: "20kb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(__dirname));

const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const WALKTHROUGH_MAX_ANSWERS = 8;
const WALKTHROUGH_MAX_QUESTION_LENGTH = 240;
const WALKTHROUGH_MAX_ANSWER_LENGTH = 1200;
const WALKTHROUGH_ALLOWED_KEYS = new Set([
  "industry",
  "team_size",
  "email",
  "pain_points",
  "tools",
  "goals",
  "timeline",
  "budget"
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const rawIp = Array.isArray(forwarded)
    ? forwarded[0]
    : String(forwarded || req.socket.remoteAddress || "unknown").split(",")[0];
  return rawIp.trim() || "unknown";
}

function enforceRateLimit(req, res, scope) {
  const key = `${scope}:${getClientIp(req)}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key) || {
    count: 0,
    resetAt: now + RATE_LIMIT_WINDOW_MS
  };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  entry.count += 1;
  rateLimitStore.set(key, entry);

  if (entry.count > RATE_LIMIT_MAX) {
    res.status(429).json({ error: "Rate limit exceeded. Try again soon." });
    return false;
  }

  return true;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const timezoneMap = {
  est: "America/New_York",
  edt: "America/New_York",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  mst: "America/Denver",
  mdt: "America/Denver",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles"
};

function normalizeTimezone(input) {
  if (!input) return "America/Chicago";
  const key = String(input).trim().toLowerCase();
  return timezoneMap[key] || input;
}

function parseWindow(input) {
  if (!input) return null;
  const match = String(input).match(/(\d{1,2})\s*-\s*(\d{1,2})/);
  if (!match) return null;
  let start = Number(match[1]);
  let end = Number(match[2]);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (end <= start && start < 12) {
    end += 12;
  }
  if (start < 0 || start > 23 || end < 1 || end > 24) return null;
  return { start, end };
}

function formatSlotLabel(iso, timezone) {
  try {
    const date = new Date(iso);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
    return formatter.format(date) + " (" + timezone + ")";
  } catch {
    return iso;
  }
}

function slotMatchesWindow(iso, timezone, window) {
  if (!window) return true;
  try {
    const date = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false
    }).formatToParts(date);
    const hourPart = parts.find((part) => part.type === "hour");
    const hour = Number(hourPart?.value);
    if (Number.isNaN(hour)) return true;
    return hour >= window.start && hour < window.end;
  } catch {
    return true;
  }
}

app.post("/api/chat", async (req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({ error: "Missing OPEN_AI_KEY." });
    }

    if (!enforceRateLimit(req, res, "chat")) {
      return;
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
      "If asked about services, list: Local Search Visibility Fix Sprint,",
      "AI Strategy Assessment, AI Integration, Custom AI Development,",
      "AI Training & Enablement, Ongoing AI Support, and Talks & Presentations.",
      "The Local Search Visibility Fix Sprint has a dedicated page at",
      "https://rossapplied.ai/services/local-search-visibility/.",
      "The only published pricing facts you may state are:",
      "the Local Search Visibility Fix Sprint founding pilot is $500,",
      "its standard price later is $1,250, and 50% is due upfront;",
      "Starter is $1,750; Growth is $7,500; Enterprise is $20,000+;",
      "the ongoing support retainer is $1,500/month;",
      "Talks & Presentations says Tulsa-area keynotes start at $500.",
      "For packages and the retainer, link to https://rossapplied.ai/services/.",
      "For talks, link to https://rossapplied.ai/services/talks/.",
      "Repeat those prices exactly when relevant and link to the corresponding service page.",
      "Never invent, estimate, alter, round, discount, or convert a price.",
      "For any pricing question not covered by those published facts, say pricing is",
      "not published and direct the visitor to https://rossapplied.ai/services/",
      "or https://rossapplied.ai/book-call/.",
      "Do not claim the founding pilot is available unless the public page says so.",
      "Do not invent client results, rankings, availability, timelines, or guarantees.",
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

app.post("/api/walkthrough", async (req, res) => {
  try {
    if (!enforceRateLimit(req, res, "walkthrough")) {
      return;
    }

    const payload = req.body || {};
    if (payload.answers !== undefined && !Array.isArray(payload.answers)) {
      return res.status(400).json({ error: "Answers must be an array." });
    }

    const rawAnswers = Array.isArray(payload.answers) ? payload.answers : [];
    if (rawAnswers.length === 0) {
      return res.status(400).json({ error: "Answers are required." });
    }
    if (rawAnswers.length > WALKTHROUGH_MAX_ANSWERS) {
      return res.status(400).json({ error: "Too many answers." });
    }

    const answers = [];
    const seenKeys = new Set();
    for (const [index, item] of rawAnswers.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return res.status(400).json({ error: `Answer ${index + 1} is invalid.` });
      }
      if (
        typeof item.key !== "string" ||
        typeof item.question !== "string" ||
        typeof item.answer !== "string"
      ) {
        return res.status(400).json({ error: `Answer ${index + 1} has invalid fields.` });
      }

      const key = item.key.trim().toLowerCase();
      const question = item.question.trim();
      const answer = item.answer.trim();

      if (!WALKTHROUGH_ALLOWED_KEYS.has(key)) {
        return res.status(400).json({ error: `Answer ${index + 1} has an invalid key.` });
      }
      if (seenKeys.has(key)) {
        return res.status(400).json({ error: `Answer key "${key}" is duplicated.` });
      }
      if (!question || question.length > WALKTHROUGH_MAX_QUESTION_LENGTH) {
        return res.status(400).json({ error: `Answer ${index + 1} has an invalid question.` });
      }
      if (!answer || answer.length > WALKTHROUGH_MAX_ANSWER_LENGTH) {
        return res.status(400).json({ error: `Answer ${index + 1} has an invalid response.` });
      }

      seenKeys.add(key);
      answers.push({ key, question, answer });
    }

    const emailFromKey = answers.find((item) => item.key === "email");
    const emailFromQuestion = answers.find((item) =>
      item.question.toLowerCase().includes("email")
    );
    const emailFromAnswerPattern = answers.find((item) => EMAIL_PATTERN.test(item.answer));
    const userEmail = String(
      emailFromKey?.answer || emailFromQuestion?.answer || emailFromAnswerPattern?.answer || ""
    ).trim();

    if (userEmail && (userEmail.length > 254 || !EMAIL_PATTERN.test(userEmail))) {
      return res.status(400).json({ error: "A valid email address is required." });
    }

    const systemPrompt = [
      "You are the Ross Applied AI Consulting walkthrough assistant.",
      "Extract key business details from the user's answers and recommend",
      "the most relevant services we offer.",
      "Services: Local Search Visibility Fix Sprint, AI Strategy Assessment,",
      "AI Integration, Custom AI Development, AI Training & Enablement,",
      "Ongoing AI Support, and Talks & Presentations.",
      "Recommendations must be qualitative. Do not produce readiness scores,",
      "performance forecasts, fabricated metrics, or guaranteed outcomes.",
      "Return ONLY valid JSON with this schema:",
      "{",
      '  "summary": string,',
      '  "extracted": {',
      '    "industry": string,',
      '    "team_size": string,',
      '    "pain_points": string,',
      '    "tools": string,',
      '    "goals": string,',
      '    "timeline": string,',
      '    "budget": string',
      "  },",
      '  "recommended_services": string[],',
      '  "suggested_next_step": string',
      "}",
      "Keep the summary to 3-5 sentences, business-focused, and specific.",
      "If info is missing, say 'unknown' in extracted fields.",
      "Do not include markdown or extra keys."
    ].join(" ");

    function buildFallbackReport() {
      const toLower = (value) => String(value || "").toLowerCase();
      const findAnswer = (keys, questionHints = keys) => {
        const keyCandidates = keys.map((key) => String(key).toLowerCase());
        const byKey = answers.find((item) =>
          keyCandidates.includes(String(item.key || "").toLowerCase())
        );
        if (byKey?.answer) {
          return byKey.answer;
        }

        const hints = questionHints.map((hint) => String(hint).toLowerCase());
        const byQuestion = answers.find((item) => {
          const question = String(item.question || "").toLowerCase();
          return hints.some((hint) => question.includes(hint));
        });
        return byQuestion?.answer || "unknown";
      };

      const industry = findAnswer(["industry"], ["business", "industry"]);
      const teamSize = findAnswer(["team_size"], ["team"]);
      const painPoints = findAnswer(["pain_points"], ["bottleneck", "pain point"]);
      const tools = findAnswer(["tools"], ["tools", "systems"]);
      const goals = findAnswer(["goals"], ["outcome", "goal"]);
      const timeline = findAnswer(["timeline"], ["timeline", "urgent", "timing"]);
      const budget = findAnswer(["budget"], ["budget"]);

      const recommended = new Set(["AI Strategy Assessment"]);
      const pain = toLower(painPoints);
      const goal = toLower(goals);
      const tool = toLower(tools);

      if (pain.includes("manual") || pain.includes("spreadsheet") || tool.includes("crm")) {
        recommended.add("AI Integration");
      }
      if (goal.includes("automate") || pain.includes("repetitive") || pain.includes("admin")) {
        recommended.add("Custom AI Development");
      }
      if (goal.includes("training") || pain.includes("adoption")) {
        recommended.add("AI Training & Enablement");
      }
      if (goal.includes("support") || pain.includes("maintenance")) {
        recommended.add("Ongoing AI Support");
      }

      const timing =
        timeline === "unknown" ? "the timing you described" : `the stated timing (${timeline})`;
      const summary =
        `Your answers point to workflow friction in ${industry} and a need to consider ` +
        `${timing}. An AI Strategy Assessment would provide a structured way to ` +
        `review the current tools, constraints, and goals before choosing an implementation. ` +
        `Any first-workflow recommendation should be confirmed with the team rather than ` +
        `treated as a forecast or guaranteed outcome.`;

      return {
        summary,
        extracted: {
          industry,
          team_size: teamSize,
          pain_points: painPoints,
          tools,
          goals,
          timeline,
          budget
        },
        recommended_services: Array.from(recommended),
        suggested_next_step:
          "Book a call to review the assessment scope and choose a practical first workflow."
      };
    }

    let parsed;
    if (!openai) {
      parsed = buildFallbackReport();
    } else {
      try {
        const response = await openai.responses.create({
          model,
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: systemPrompt }]
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({ answers })
                }
              ]
            }
          ]
        });

        const raw = response.output_text?.trim();
        if (!raw) {
          throw new Error("Empty model response.");
        }

        try {
          parsed = JSON.parse(raw);
        } catch (parseError) {
          const match = raw.match(/\{[\s\S]*\}/);
          if (!match) {
            throw parseError;
          }
          parsed = JSON.parse(match[0]);
        }
      } catch (modelError) {
        console.error("Walkthrough model error:", modelError?.message || modelError);
        parsed = buildFallbackReport();
      }
    }

    if (!parsed || typeof parsed !== "object") {
      parsed = buildFallbackReport();
    }

    const emailSubject = "Your AI Walkthrough Summary";
    const internalSubject = "New AI Walkthrough Submission";
    const services = Array.isArray(parsed.recommended_services)
      ? parsed.recommended_services
      : [];
    const servicesList = services.length ? services.join(", ") : "To be discussed";
    const extracted = parsed.extracted || {};
    const summaryText = parsed.summary || "Thanks for completing the walkthrough.";
    const suggestedNext = parsed.suggested_next_step || "Book a call to map the plan.";

    const safeSummaryText = escapeHtml(summaryText);
    const safeServicesList = escapeHtml(servicesList);
    const safeSuggestedNext = escapeHtml(suggestedNext);
    const safeExtracted = {
      industry: escapeHtml(extracted.industry || "unknown"),
      teamSize: escapeHtml(extracted.team_size || "unknown"),
      painPoints: escapeHtml(extracted.pain_points || "unknown"),
      tools: escapeHtml(extracted.tools || "unknown"),
      goals: escapeHtml(extracted.goals || "unknown"),
      timeline: escapeHtml(extracted.timeline || "unknown"),
      budget: escapeHtml(extracted.budget || "unknown")
    };
    const submittedAt = new Date().toISOString();

    const html = `
      <div style="font-family: Arial, sans-serif; color: #0f172a;">
        <h2>AI Walkthrough Summary</h2>
        <p>${safeSummaryText}</p>
        <h3>Recommended Services</h3>
        <p>${safeServicesList}</p>
        <h3>Key Details</h3>
        <ul>
          <li><strong>Industry:</strong> ${safeExtracted.industry}</li>
          <li><strong>Team size:</strong> ${safeExtracted.teamSize}</li>
          <li><strong>Pain points:</strong> ${safeExtracted.painPoints}</li>
          <li><strong>Tools:</strong> ${safeExtracted.tools}</li>
          <li><strong>Goals:</strong> ${safeExtracted.goals}</li>
          <li><strong>Timeline:</strong> ${safeExtracted.timeline}</li>
          <li><strong>Budget:</strong> ${safeExtracted.budget}</li>
        </ul>
        <p><strong>Next step:</strong> ${safeSuggestedNext}</p>
        <p><a href="https://rossapplied.ai/book-call/">Book a call</a></p>
      </div>
    `;

    const answersHtml = answers
      .map((item) => {
        const question = escapeHtml(item.question || "unknown");
        const answer = escapeHtml(item.answer || "unknown");
        return `<li><strong>${question}</strong>: ${answer}</li>`;
      })
      .join("");

    const internalHtml = `
      <div style="font-family: Arial, sans-serif; color: #0f172a;">
        <h2>New AI Walkthrough Submission</h2>
        <p><strong>Submitted at:</strong> ${escapeHtml(submittedAt)}</p>
        <p><strong>User email:</strong> ${escapeHtml(userEmail || "(not provided)")}</p>
        <h3>Generated Summary</h3>
        <p>${safeSummaryText}</p>
        <h3>Recommended Services</h3>
        <p>${safeServicesList}</p>
        <h3>Submitted Answers</h3>
        <ul>${answersHtml}</ul>
      </div>
    `;

    const text = [
      "AI Walkthrough Summary",
      summaryText,
      "",
      "Recommended Services: " + servicesList,
      "Industry: " + (extracted.industry || "unknown"),
      "Team size: " + (extracted.team_size || "unknown"),
      "Pain points: " + (extracted.pain_points || "unknown"),
      "Tools: " + (extracted.tools || "unknown"),
      "Goals: " + (extracted.goals || "unknown"),
      "Timeline: " + (extracted.timeline || "unknown"),
      "Budget: " + (extracted.budget || "unknown"),
      "Next step: " + suggestedNext,
      "Book a call: https://rossapplied.ai/book-call/"
    ].join("\n");

    const internalText = [
      "New AI Walkthrough Submission",
      "Submitted at: " + submittedAt,
      "User email: " + (userEmail || "(not provided)"),
      "",
      "Summary:",
      summaryText,
      "",
      "Recommended Services:",
      servicesList,
      "",
      "Submitted Answers:",
      ...answers.map((item) =>
        `${String(item?.question || "unknown")}: ${String(item?.answer || "unknown")}`
      )
    ].join("\n");

    let internalEmailError = "";
    let userEmailError = "";

    if (!resendApiKey) {
      internalEmailError = "Missing RESEND_API_KEY.";
      userEmailError = "Missing RESEND_API_KEY.";
    } else {
      try {
        await sendResendEmail({
          to: "hello@rossapplied.ai",
          subject: internalSubject,
          html: internalHtml,
          text: internalText
        });
      } catch (sendError) {
        internalEmailError = sendError?.message || "Internal email send failed.";
        console.error("Internal walkthrough email error:", internalEmailError);
      }

      if (userEmail) {
        try {
          await sendResendEmail({
            to: userEmail,
            subject: emailSubject,
            html,
            text
          });
        } catch (sendError) {
          userEmailError = sendError?.message || "User email send failed.";
          console.error("User walkthrough email error:", userEmailError);
        }
      } else {
        userEmailError = "No user email captured.";
      }
    }

    res.json({
      ...parsed,
      emailed_to: userEmailError ? "" : userEmail,
      email_error: userEmailError,
      owner_notified: !internalEmailError,
      owner_email_error: internalEmailError
    });
  } catch (error) {
    const message = error?.message || "Walkthrough service error.";
    console.error("Walkthrough error:", message);
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
    const timezone = normalizeTimezone(req.body?.timezone);
    const startAfter = String(req.body?.startAfter || "").trim();

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
    const eventTypeUri = selected?.uri;
    if (!eventTypeUri) {
      return res.status(500).json({ error: "Calendly event type URI missing." });
    }

    const window = parseWindow(times);
    const start = startAfter ? new Date(startAfter) : new Date();
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

    const availableResp = await fetch(
      `https://api.calendly.com/event_type_available_times?event_type=${encodeURIComponent(
        eventTypeUri
      )}&start_time=${encodeURIComponent(start.toISOString())}&end_time=${encodeURIComponent(
        end.toISOString()
      )}`,
      { headers }
    );
    if (!availableResp.ok) {
      return res.status(500).json({ error: "Calendly availability lookup failed." });
    }
    const availableData = await availableResp.json();
    const slots = Array.isArray(availableData?.collection) ? availableData.collection : [];
    const filtered = slots
      .filter((slot) => slotMatchesWindow(slot.start_time, timezone, window))
      .slice(0, 3)
      .map((slot) => ({
        start_time: slot.start_time,
        end_time: slot.end_time,
        label: formatSlotLabel(slot.start_time, timezone)
      }));

    res.json({
      suggestions: filtered,
      eventTypeUri,
      summary: filtered.length
        ? "Here are a few available times."
        : "No available times matched. Try a different window or timezone."
    });
  } catch (error) {
    res.status(500).json({ error: "Schedule service error." });
  }
});

app.post("/api/schedule/confirm", async (req, res) => {
  try {
    if (!calendlyToken) {
      return res.status(500).json({ error: "Missing CALENDLY_API." });
    }

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim();
    const timezone = normalizeTimezone(req.body?.timezone);
    const eventTypeUri = String(req.body?.eventTypeUri || "").trim();
    const startTime = String(req.body?.startTime || "").trim();

    if (!name || !email || !eventTypeUri || !startTime) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const headers = {
      Authorization: `Bearer ${calendlyToken}`,
      "Content-Type": "application/json"
    };

    const eventTypeId = eventTypeUri.split("/").pop();
    let locationPayload;
    if (eventTypeId) {
      const eventTypeResp = await fetch(
        `https://api.calendly.com/event_types/${eventTypeId}`,
        { headers }
      );
      if (eventTypeResp.ok) {
        const eventTypeData = await eventTypeResp.json();
        const location = eventTypeData?.resource?.location;
        if (location?.kind) {
          locationPayload = { kind: location.kind };
          if (location.location) {
            locationPayload.location = location.location;
          }
        }
      }
    }

    const inviteePayload = {
      event_type: eventTypeUri,
      start_time: startTime,
      invitee: {
        name,
        email,
        timezone
      }
    };

    if (locationPayload) {
      inviteePayload.location = locationPayload;
    }

    const inviteeResp = await fetch("https://api.calendly.com/invitees", {
      method: "POST",
      headers,
      body: JSON.stringify(inviteePayload)
    });

    if (!inviteeResp.ok) {
      return res.status(500).json({ error: "Calendly booking failed." });
    }

    const inviteeData = await inviteeResp.json();
    res.json({
      summary: "You’re booked! A confirmation email is on the way.",
      rescheduleUrl: inviteeData?.resource?.reschedule_url,
      cancelUrl: inviteeData?.resource?.cancel_url
    });
  } catch (error) {
    res.status(500).json({ error: "Schedule confirmation failed." });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
