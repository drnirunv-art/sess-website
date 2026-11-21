// SESS website Worker: serves the static site and a small AI chat endpoint.
// Uses Google Gemini when the GEMINI_API_KEY secret is set on the Worker;
// otherwise falls back to Cloudflare Workers AI (free daily allowance).

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_MSG_CHARS = 600;
const MAX_HISTORY = 8;

const SYSTEM_PROMPT = `You are the website assistant of SESS — Siam Engineering Solution Services Co., Ltd. (บริษัท สยาม เอ็นจิเนียริ่ง โซลูชั่น เซอร์วิส จำกัด), a Thai building-engineering company.

Answer ONLY questions about SESS, its services, experience and how to contact it. Reply in the same language the visitor uses (Thai or English). Be polite, warm and short (2–5 sentences, or a short list). In Thai, use polite particles (ครับ).

Company facts (use only these; never invent anything else):
- Services (6): 1) Building engineering systems (MEP: electrical, HVAC, plumbing, fire protection, BAS) — design, installation, diagnostics, upgrades. 2) Energy conservation — energy audits, solar roof, LED, VSD, chiller optimization, EV charging, help with DEDE (พพ.) grants. 3) Building inspection by a registered building inspector, risk and fire-safety assessment. 4) Construction & renovation — incl. operating rooms, negative/positive pressure rooms, clean rooms, MEP works. 5) Medical equipment — supply, installation and maintenance of medical equipment and hospital support systems to JCI/HA standards. 6) Facilities Management (FM) — setup from startup, O&M, PM/CM, KPI/SLA, Smart IoT, JCI / ISO 41001 readiness.
- Leadership team experience: 30+ years; managed engineering/FM for 12 Phyathai & Paolo hospitals (200 staff); Siam Commercial Bank HQ and buildings (570,000+ sqm); Stock Exchange of Thailand buildings A–C (57,000+ sqm); 500+ AP Thailand residential sites with Smart IoT monitoring; Bangkok Hospital HQ (200,000+ sqm, District Cooling Plant, 26,000-bulb LED retrofit); Ramathibodi Chakri Naruebodindra Hospital (400 rai campus).
- Awards/standards: BEAT 2010 (Building Energy Award of Thailand), BSA Platinum, Thailand Quality Class (TQC) contribution, JCI surveys; standards JCI, HA, ISO 41001/9001/14001/45001, AHA, BSA, BEC, NFPA.
- Team credentials: licensed professional electrical engineer (วิศวกรควบคุม), senior energy specialist (ผชอ.), AEMAS certified energy manager, registered building inspector, JCI FMS certificate.
- Contact: phone 065-653-5655, email sess.phd@gmail.com. Address: 501 ซ.รังสิต-นครนายก 44 ต.ประชาธิปัตย์ อ.ธัญบุรี จ.ปทุมธานี 12130. Website sess-th.com. Initial consultation is free.

Rules:
- Never quote prices, discounts, timelines or guarantees. For quotations, site surveys or project details, invite the visitor to call 065-653-5655 or email sess.phd@gmail.com.
- Never give names of individual people. Never share a tax ID or any personal data.
- If the visitor wants a call back, a quotation or a site survey, invite them to type their name and phone number (or email) in this chat; the SESS team is notified and will contact them. Thank them when they do.
- If you don't know, say so and give the contact details. Do not make up projects, clients or certifications.
- If asked about unrelated topics, politely say you can only help with SESS services.
- Do not give detailed safety-critical engineering instructions (e.g. live electrical work); recommend a professional site visit instead.`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// ---- Notifications (Telegram + LINE). Each is active only when its secrets are set. ----
// Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  -> every visitor question
// LINE (Messaging API): LINE_CHANNEL_TOKEN, LINE_USER_ID -> first question of a chat, or any
//   message that contains a phone number / email (LINE free plan has a small monthly quota)
const CONTACT_RE = /(\d[\d\s-]{7,}\d)|([\w.+-]+@[\w-]+\.[\w.]+)/;

async function notify(env, question, reply, isFirst) {
  const time = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
  const text =
    `💬 คำถามใหม่จากเว็บ sess-th.com\n🕒 ${time}\n\n❓ ${question}\n\n🤖 AI ตอบ: ${(reply || "-").slice(0, 600)}`;
  const jobs = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      })
    );
  }
  if (env.LINE_CHANNEL_TOKEN && env.LINE_USER_ID && (isFirst || CONTACT_RE.test(question))) {
    jobs.push(
      fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` },
        body: JSON.stringify({ to: env.LINE_USER_ID, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
      })
    );
  }
  const res = await Promise.allSettled(jobs);
  res.forEach((r) => r.status === "rejected" && console.error("notify error", r.reason && r.reason.message));
}

async function handleChat(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const history = Array.isArray(body?.messages) ? body.messages : [];
  const messages = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ error: "bad_request" }, 400);
  }
  const question = messages[messages.length - 1].content;
  const isFirst = messages.filter((m) => m.role === "user").length === 1;
  let reply = "";
  if (env.GEMINI_API_KEY) {
    try {
      reply = await askGemini(messages, env.GEMINI_API_KEY);
    } catch (err) {
      console.error("Gemini error", err && err.message);
    }
  }
  if (!reply) {
    try {
      const out = await env.AI.run(MODEL, {
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        max_tokens: 500,
        temperature: 0.3,
      });
      reply = String((out && (out.response ?? out.result?.response)) || "").trim();
    } catch (err) {
      console.error("AI error", err && err.message);
    }
  }
  const notifying = notify(env, question, reply || "(AI ไม่พร้อมใช้งาน)", isFirst);
  if (ctx && ctx.waitUntil) ctx.waitUntil(notifying);
  if (!reply) return json({ error: "ai_unavailable" }, 503);
  return json({ reply });
}

async function askGemini(messages, key) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { temperature: 0.3, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return handleChat(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
