# SESS website

เว็บไซต์บริษัท สยาม เอ็นจิเนียริ่ง โซลูชั่น เซอร์วิส จำกัด (sess-th.com)
Static site deployed on Cloudflare Workers (static assets).

## AI chat
`worker.js` serves the site and `POST /api/chat`. It uses Google Gemini when the Worker secret `GEMINI_API_KEY` is set (Cloudflare > Workers > sess-website > Settings > Variables and Secrets), otherwise Cloudflare Workers AI (binding `AI`). Company facts for the bot are in `SYSTEM_PROMPT` in worker.js.
Notifications: set Worker secrets TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (every question) and/or LINE_CHANNEL_TOKEN + LINE_USER_ID (first question per chat, or messages with phone/email).

### LINE group alerts (automatic)
1. LINE Official Account Manager > Settings: allow the account to join group chats; Response settings: Webhook ON.
2. LINE Developers > channel > Basic settings: copy **Channel secret** -> Cloudflare secret `LINE_CHANNEL_SECRET`.
3. Messaging API tab: Webhook URL `https://<site>/api/line-webhook`, Use webhook ON.
4. Add the OA to any LINE group the owner (LINE_USER_ID) is in: the group is saved in KV (binding STORE) and gets alerts. Remove the bot to stop, or the owner types `ปิดแจ้งเตือน` / `เปิดแจ้งเตือน` in the group.
Note: a push to a group counts once per group member against the monthly free quota (200 on the free plan).
