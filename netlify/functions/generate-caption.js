// generate-caption.js
// Turns a brief (+ optional image) into a ready-to-post caption in the user's voice.
// Server-side so members never need their own AI key.
//
// Also enforces the FREE-TIER monthly post limit (this is the paywall lever):
//   - Subscribers (sub_status = 'active') are unlimited.
//   - Free users get FREE_POST_LIMIT posts per calendar month (default 3).
//   - Only the primary "write my caption" call is metered (meter:true); rewrites are free.
//
// Env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//           FREE_POST_LIMIT (optional, default 3)

const { createClient } = require('@supabase/supabase-js');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const FREE_LIMIT = parseInt(process.env.FREE_POST_LIMIT || '3', 10);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function period() { return new Date().toISOString().slice(0, 7); } // 'YYYY-MM'

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Caption service is not configured yet.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Bad request.' }) }; }

  const brief = (body.brief || '').toString().slice(0, 2000).trim();
  if (!brief) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please add a brief so I know what to write.' }) };
  }

  const image = body.image && body.image.data && body.image.media_type ? body.image : null;

  // ----- usage metering (only when the client asks for it, i.e. the primary generate) -----
  let meterUser = null, subscribed = false, used = 0;
  if (body.access_token) {
    try {
      const { data: { user } } = await supabaseAdmin.auth.getUser(body.access_token);
      if (user) {
        meterUser = user;
        const { data: ent } = await supabaseAdmin
          .from('entitlements')
          .select('sub_status,usage_period,usage_count')
          .eq('user_id', user.id)
          .maybeSingle();
        subscribed = !!(ent && ent.sub_status === 'active');
        used = (ent && ent.usage_period === period()) ? (ent.usage_count || 0) : 0;
      }
    } catch (e) { /* if we can't verify, fall through unmetered (preview) */ }
  }

  const willMeter = body.meter === true && meterUser && !subscribed;
  if (willMeter && used >= FREE_LIMIT) {
    return {
      statusCode: 402,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'limit_reached', limit: FREE_LIMIT, used }),
    };
  }

  // ----- the user's voice profile -----
  const v = body.voice || {};
  const voiceLines = [];
  if (v.tone)     voiceLines.push('Tone and personality: ' + v.tone + '.');
  if (v.audience) voiceLines.push('Who they are talking to: ' + v.audience + '.');
  if (v.topics)   voiceLines.push('What they post about: ' + v.topics + '.');
  if (v.avoid)    voiceLines.push('Things to avoid: ' + v.avoid + '.');
  if (v.sample)   voiceLines.push('A sample of how this person writes — match this style closely:\n"' + String(v.sample).slice(0, 1200) + '"');

  const system =
    "You are a social media copywriter who writes in the user's OWN voice. " +
    "Write ONE ready-to-post caption based on their brief (and the image, if provided). " +
    (voiceLines.length
      ? "Write it so it genuinely sounds like this specific person:\n" + voiceLines.join("\n") + "\n"
      : "Tone: warm, authentic, and professional — never salesy or spammy. ") +
    "Structure: 1 to 3 short paragraphs, then a single line with 3 to 6 relevant hashtags. " +
    "Do not use markdown, asterisks, bold, or headers. Return ONLY the caption text, nothing else.";

  const content = [];
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } });
  }
  content.push({ type: 'text', text: 'Brief: ' + brief });

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, system, messages: [{ role: 'user', content }] }),
    });

    const data = await r.json();
    if (!r.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'The caption service had a problem. Please try again.' }) };
    }

    const caption = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    // Count this post against the free allowance (only for metered free-tier calls).
    if (willMeter) {
      try {
        await supabaseAdmin.from('entitlements').upsert(
          { user_id: meterUser.id, usage_period: period(), usage_count: used + 1, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' }
        );
      } catch (e) { /* don't fail the caption if the counter write hiccups */ }
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caption, subscribed, used: willMeter ? used + 1 : used, limit: FREE_LIMIT }),
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'The caption service is unavailable right now.' }) };
  }
};
