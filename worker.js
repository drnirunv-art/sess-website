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
- Contact: phone 065-653-5655, email sales@sess-th.com. Address: 501 ซ.รังสิต-นครนายก 44 ต.ประชาธิปัตย์ อ.ธัญบุรี จ.ปทุมธานี 12130. Website sess-th.com. Initial consultation is free.

Rules:
- Never quote prices, discounts, timelines or guarantees. For quotations, site surveys or project details, invite the visitor to call 065-653-5655 or email sales@sess-th.com.
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
// LINE (Messaging API): LINE_CHANNEL_TOKEN + LINE_USER_ID, plus every group the bot was added to
//   (saved automatically, see LINE webhook below) -> first question of a chat, or any
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
  const lineTargets = [
    ...new Set(
      [env.LINE_USER_ID, ...String(env.LINE_GROUP_ID || "").split(","), ...(await getGroups(env))]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter(Boolean)
    ),
  ];
  if (env.LINE_CHANNEL_TOKEN && lineTargets.length && (isFirst || CONTACT_RE.test(question))) {
    for (const to of lineTargets) {
      jobs.push(
        fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${env.LINE_CHANNEL_TOKEN.trim()}` },
          body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
        })
      );
    }
  }
  const res = await Promise.allSettled(jobs);
  for (const r of res) {
    if (r.status === "rejected") console.error("notify error", r.reason && r.reason.message);
    else if (!r.value.ok) console.error("notify HTTP", r.value.status, r.value.url.split("/bot")[0], await r.value.text());
  }
}

// ---- LINE groups, stored in KV (binding STORE, key "line_groups").
// The bot joins a group -> if the owner (LINE_USER_ID) is a member, the group is saved and starts
// getting alerts automatically. Bot removed from the group -> it is deleted. In a group, the owner
// can also type "ปิดแจ้งเตือน" / "เปิดแจ้งเตือน" to turn alerts off / on for that group.
async function getGroups(env) {
  if (!env.STORE) return [];
  try {
    return JSON.parse((await env.STORE.get("line_groups")) || "[]");
  } catch {
    return [];
  }
}
async function setGroup(env, id, on) {
  if (!env.STORE) return;
  const groups = (await getGroups(env)).filter((g) => g !== id);
  if (on) groups.push(id);
  await env.STORE.put("line_groups", JSON.stringify(groups));
}
const lineApi = (env, path, init = {}) =>
  fetch("https://api.line.me" + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${env.LINE_CHANNEL_TOKEN.trim()}` },
  });
async function ownerInGroup(env, src) {
  const owner = typeof env.LINE_USER_ID === "string" ? env.LINE_USER_ID.trim() : "";
  if (!owner) return false;
  const path = src.groupId ? `/v2/bot/group/${src.groupId}/member/${owner}` : `/v2/bot/room/${src.roomId}/member/${owner}`;
  const r = await lineApi(env, path);
  return r.ok;
}
async function lineReply(env, replyToken, text) {
  const r = await lineApi(env, "/v2/bot/message/reply", {
    method: "POST",
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (!r.ok) console.error("LINE reply HTTP", r.status, await r.text());
}

// ---- LINE webhook (POST /api/line-webhook). Needs secret LINE_CHANNEL_SECRET.
async function lineWebhook(request, env) {
  const body = await request.text();
  const secret = typeof env.LINE_CHANNEL_SECRET === "string" ? env.LINE_CHANNEL_SECRET.trim() : "";
  if (!secret || !env.LINE_CHANNEL_TOKEN) return new Response("ok");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  if (request.headers.get("x-line-signature") !== expected) return new Response("bad signature", { status: 401 });
  let events = [];
  try {
    events = JSON.parse(body).events || [];
  } catch {}
  const owner = typeof env.LINE_USER_ID === "string" ? env.LINE_USER_ID.trim() : "";
  for (const ev of events) {
    const src = ev.source || {};
    const id = src.groupId || src.roomId;
    if (!id) continue;
    try {
      if (ev.type === "leave") {
        await setGroup(env, id, false);
      } else if (ev.type === "join") {
        if (await ownerInGroup(env, src)) {
          await setGroup(env, id, true);
          await lineReply(env, ev.replyToken,
            "สวัสดีครับ 🔔 SESS แจ้งเตือน จะส่งคำถามลูกค้าจากเว็บ sess-th.com เข้ากลุ่มนี้แล้วครับ\n(เจ้าของบัญชีพิมพ์ \"ปิดแจ้งเตือน\" เพื่อหยุด หรือนำบอทออกจากกลุ่ม)");
        } else {
          await lineReply(env, ev.replyToken,
            "SESS แจ้งเตือน: กลุ่มนี้ยังไม่ได้เปิดรับแจ้งเตือน ต้องมีเจ้าของบัญชีอยู่ในกลุ่ม แล้วพิมพ์ \"เปิดแจ้งเตือน\" ครับ");
        }
      } else if (ev.type === "message" && ev.message?.type === "text" && src.userId && src.userId === owner) {
        const t = (ev.message.text || "").trim();
        if (t === "เปิดแจ้งเตือน") {
          await setGroup(env, id, true);
          await lineReply(env, ev.replyToken, "✅ เปิดแจ้งเตือนคำถามจากเว็บ sess-th.com ในกลุ่มนี้แล้วครับ");
        } else if (t === "ปิดแจ้งเตือน") {
          await setGroup(env, id, false);
          await lineReply(env, ev.replyToken, "🔕 ปิดแจ้งเตือนในกลุ่มนี้แล้วครับ");
        }
      }
    } catch (err) {
      console.error("LINE webhook error", err && err.message);
    }
  }
  return new Response("ok");
}

// ---- Setup check: GET /api/notify-test shows which secrets are set (never their values).
// GET /api/notify-test?code=XXXX (XXXX = last 4 characters of LINE_USER_ID) also sends a
// test message to LINE and Telegram and shows each service's answer.
async function notifyTest(url, env) {
  const t = (v) => (typeof v === "string" ? v.trim() : "");
  const lineUser = t(env.LINE_USER_ID);
  const out = {
    telegram_token_set: !!t(env.TELEGRAM_BOT_TOKEN),
    telegram_chat_set: !!t(env.TELEGRAM_CHAT_ID),
    line_token_set: !!t(env.LINE_CHANNEL_TOKEN),
    line_user_set: !!lineUser,
    line_user_format_ok: /^U[0-9a-f]{32}$/.test(lineUser),
    line_secret_ok_for_groups: !!t(env.LINE_CHANNEL_SECRET),
    line_groups_auto: (await getGroups(env)).length,
  };
  const code = url.searchParams.get("code");
  if (!code) return json(out);
  if (!lineUser || code !== lineUser.slice(-4)) return json({ ...out, error: "wrong_code" }, 403);
  const text = "✅ ทดสอบแจ้งเตือนจากเว็บ sess-th.com";
  if (out.line_token_set) {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t(env.LINE_CHANNEL_TOKEN)}` },
      body: JSON.stringify({ to: lineUser, messages: [{ type: "text", text }] }),
    });
    out.line_result = { status: r.status, body: (await r.text()).slice(0, 300) };
  }
  if (out.telegram_token_set && out.telegram_chat_set) {
    const r = await fetch(`https://api.telegram.org/bot${t(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: t(env.TELEGRAM_CHAT_ID), text }),
    });
    out.telegram_result = { status: r.status, body: (await r.text()).slice(0, 300) };
  }
  return json(out);
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
    if (url.pathname === "/api/notify-test") return notifyTest(url, env);
    if (url.pathname === "/api/line-webhook" && request.method === "POST") return lineWebhook(request, env);
    return env.ASSETS.fetch(request);
  },
};
