# SESS website

เว็บไซต์บริษัท สยาม เอ็นจิเนียริ่ง โซลูชั่น เซอร์วิส จำกัด (sess-th.com)
Static site deployed on Cloudflare Workers (static assets).

## AI chat
`worker.js` serves the site and `POST /api/chat`. It uses Google Gemini when the Worker secret `GEMINI_API_KEY` is set (Cloudflare > Workers > sess-website > Settings > Variables and Secrets), otherwise Cloudflare Workers AI (binding `AI`). Company facts for the bot are in `SYSTEM_PROMPT` in worker.js.
