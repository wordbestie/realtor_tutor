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
const FREE_LIMIT = parseInt(process.env.FREE_POST_LIMIT || '5', 10);

// Tailors the writing to the kind of post the user picked. Realtor-flavoured for
// now (the engine's go-to-market vertical); add/edit freely for other niches.
const POST_TYPE_GUIDE = {
  just_listed:   "This is a JUST LISTED post. Build genuine excitement about a brand-new listing. Highlight what makes the property special and end with a soft invitation to book a showing or message for details.",
  just_sold:     "This is a JUST SOLD / success post. Celebrate a closed sale and let it quietly show results. Keep it gracious and client-focused, with a light invitation for anyone thinking of making a move.",
  open_house:    "This is an OPEN HOUSE post. Make it instantly clear it's an open house, and make the date, time, and place feel inviting and easy to act on. End with a clear, friendly 'come on by' style call to action.",
  market_update: "This is a MARKET UPDATE post. Share a useful, credible insight about the local market. Be helpful and authoritative, not salesy — informative first, with no pressure.",
  tip:           "This is a TIP / ADVICE post. Teach the audience one genuinely useful thing about buying, selling, or owning a home. Lead with value; keep any call to action soft.",
  testimonial:   "This is a TESTIMONIAL / client-love post. Center the client's experience and gratitude. Warm and human — let the social proof do the selling.",
  behind_scenes: "This is a BEHIND-THE-SCENES / personal post. Show the real human behind the business — a moment, a lesson, a slice of the day. Build connection and relatability over selling."
};

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function period() { return new Date().toISOString().slice(0, 7); } // 'YYYY-MM'

// True if this email is an active seat on someone's active Pro team.
async function coveredByTeam(email) {
  try {
    const { data: invites } = await supabaseAdmin.from('team_members').select('owner_id').eq('email', email).eq('status', 'invited');
    if (!invites || !invites.length) return false;
    const ids = invites.map(i => i.owner_id);
    const { data: owners } = await supabaseAdmin.from('entitlements').select('user_id').in('user_id', ids).eq('sub_tier', 'pro').eq('sub_status', 'active');
    return !!(owners && owners.length);
  } catch (e) { return false; }
}

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
  const isVideo = body.mediaType === 'video';

  // ----- usage metering (only when the client asks for it, i.e. the primary generate) -----
  // Generation requires a signed-in account. This ties every caption to a user so
  // the free limit (and your API budget) stays enforceable — no anonymous calls.
  if (!body.access_token) {
    return { statusCode: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Please sign in to generate.' }) };
  }
  let meterUser = null, subscribed = false, used = 0;
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
      // Pro/Team seats: covered by their team owner's active Pro plan (resolved live).
      if (!subscribed && user.email) {
        subscribed = await coveredByTeam(user.email.toLowerCase());
      }
    }
  } catch (e) { /* handled just below */ }
  if (!meterUser) {
    return { statusCode: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Your session expired — please sign in again.' }) };
  }

  const willMeter = body.meter === true && !subscribed;
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

  const typeGuide = POST_TYPE_GUIDE[(body.postType || '').toString()] || '';

  const voiceBlock = voiceLines.length
      ? "Write it so it genuinely sounds like this specific person:\n" + voiceLines.join("\n") + "\n"
      : "Tone: warm, authentic, and professional — never salesy or spammy. ";

  const system = isVideo
    ? ("You are a social media copywriter who writes in the user's OWN voice. " +
       "They are posting a VIDEO. Based on their brief, write the post text. " +
       voiceBlock + (typeGuide ? typeGuide + ' ' : '') +
       "Return ONLY a JSON object (no markdown, no code fences) with exactly these keys: " +
       '"caption" (the social caption for Instagram/Facebook/LinkedIn: 1 to 3 short paragraphs, then a line with 3 to 6 relevant hashtags), ' +
       '"ytTitle" (a punchy YouTube title, max 100 characters, no hashtags), ' +
       '"ytDescription" (a YouTube description: 2 to 4 sentences in their voice, may end with a soft call to action). ' +
       "Do not use markdown, asterisks, bold, or headers inside any value.")
    : ("You are a social media copywriter who writes in the user's OWN voice. " +
       "Write ONE ready-to-post caption based on their brief (and the image, if provided). " +
       voiceBlock + (typeGuide ? typeGuide + ' ' : '') +
       "Structure: 1 to 3 short paragraphs, then a single line with 3 to 6 relevant hashtags. " +
       "Do not use markdown, asterisks, bold, or headers. Return ONLY the caption text, nothing else.");

  const content = [];
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } });
  }
  content.push({ type: 'text', text: 'Brief: ' + brief });

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: isVideo ? 700 : 500, system, messages: [{ role: 'user', content }] }),
    });

    const data = await r.json();
    if (!r.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'The caption service had a problem. Please try again.' }) };
    }

    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    let caption = raw, ytTitle = '', ytDescription = '';
    if (isVideo) {
      try {
        const clean = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        const j = JSON.parse(clean);
        caption = (j.caption || '').toString().trim();
        ytTitle = (j.ytTitle || '').toString().trim().slice(0, 100);
        ytDescription = (j.ytDescription || '').toString().trim();
      } catch (e) {
        caption = raw;
        ytTitle = (raw.split('\n')[0] || '').slice(0, 100);
        ytDescription = raw;
      }
    }

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
      body: JSON.stringify(Object.assign({ caption, subscribed, used: willMeter ? used + 1 : used, limit: FREE_LIMIT }, isVideo ? { ytTitle, ytDescription } : {})),
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'The caption service is unavailable right now.' }) };
  }
};
