// Vercel serverless function: POST /api/ask
// Keeps the Anthropic API key on the server. Needs one environment variable in Vercel:
//   ANTHROPIC_API_KEY
const SB_URL = 'https://vagsqfyedfxfvzzcgoqt.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhZ3NxZnllZGZ4ZnZ6emNnb3F0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyOTkzNjQsImV4cCI6MjA5Nzg3NTM2NH0.gc98UvxrcjoIHhjCt8a5Gj2AuksOkvdiyYap8J_Vf8Y';   // same public (anon) key the web page already uses
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_BODY_CHARS = 200000;
const LIMIT_PER_HOUR = 30;
const hits = new Map(); // best-effort rate limit per session (resets when the function restarts)

const BLOCKED_KEYS = /^(patients?|patient_list|name|full_?name|patient_?name|id_?no|id_?number|phone|nok|next_of_kin.*|email|address|ip|discharge_notes|notes?|reason|requested_by|by_user|password|token)$/i;
function scrub(v, depth = 0) {
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.slice(0, 2000).map(x => scrub(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (BLOCKED_KEYS.test(k)) continue;           // second line of defence: never forward identifiers
      o[k] = scrub(val, depth + 1);
    }
    return o;
  }
  if (typeof v === 'string') return v.slice(0, 300);
  return v;
}

const SYSTEM = `You are the data assistant inside "Renal Roads", a dialysis ward management system run by Benacare in Kenya.
You answer staff questions using ONLY the JSON data supplied with the question. The data is anonymised: patients appear only as grouped counts, never as individual records.
Rules:
- Use only the supplied data. If the answer is not in the data, say so plainly. Never guess or invent numbers.
- Count carefully and show the figure first, then one short line of explanation. Use short lists when comparing items.
- You are not a clinician. Do not give diagnoses, treatment or medication advice. For clinical questions, say a doctor must decide.
- If asked to identify, name, look up or contact an individual patient, refuse: you only have grouped counts. A count shown as "<3" means 1 or 2 people and must never be worked out, narrowed down or guessed; do not try to deduce who they might be. If the question includes a person's name, do not repeat or use it.
- Stock "low" means stock is at or below its low-stock threshold.
- Reply in the language of the question (English or Kiswahili). Keep answers brief.`;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(500).json({ error: 'The assistant is not set up yet (missing ANTHROPIC_API_KEY on the server).' });

    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    body = body || {};
    const { question, session, context, history } = body;
    if (!session || typeof session !== 'string') return res.status(401).json({ error: 'Please sign in again.' });
    if (!question || typeof question !== 'string' || question.length > 600) return res.status(400).json({ error: 'Please ask a shorter question.' });
    if (/\d[\d\s\-]{5,}\d/.test(question)) return res.status(400).json({ error: 'For privacy, please do not include phone or ID numbers in a question.' });
    if (JSON.stringify(body).length > MAX_BODY_CHARS) return res.status(413).json({ error: 'There is too much data to send. Try a narrower question.' });

    // 1. Only signed-in, active users may use it
    const r = await fetch(SB_URL + '/rest/v1/rpc/rr_resume_session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
      body: JSON.stringify({ p_session: session })
    });
    const rows = r.ok ? await r.json() : null;
    const me = rows && rows[0];
    if (!me || !me.active) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });

    // 2. Simple per-session limit
    const now = Date.now();
    const arr = (hits.get(session) || []).filter(t => now - t < 3600000);
    if (arr.length >= LIMIT_PER_HOUR) return res.status(429).json({ error: 'Hourly question limit reached. Please try again later.' });
    arr.push(now); hits.set(session, arr);

    // 3. Ask the model
    const safe = scrub(context || {});
    const msgs = [];
    (Array.isArray(history) ? history.slice(-6) : []).forEach(h => {
      if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') msgs.push({ role: h.role, content: h.content.slice(0, 1500) });
    });
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    msgs.push({ role: 'user', content: 'DATA (anonymised, as loaded in the app right now):\n' + JSON.stringify(safe) + '\n\nQUESTION: ' + question });

    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM, messages: msgs })
    });
    const out = await ar.json();
    if (!ar.ok) return res.status(502).json({ error: 'The AI service could not answer right now.' });
    const text = (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    return res.status(200).json({ answer: text || 'I could not produce an answer.' });
  } catch (e) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
