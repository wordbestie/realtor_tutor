// suggest-ideas.js
// Suggests a handful of post ideas tailored to the user's voice profile, so they
// never face a blank box. Server-side so members never need their own AI key.
//
// Requires a Netlify environment variable: ANTHROPIC_API_KEY

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Idea service is not configured yet.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Bad request.' }) }; }

  // The user's voice profile drives what the ideas are about.
  const v = body.voice || {};
  const voiceLines = [];
  if (v.tone)     voiceLines.push('Tone and personality: ' + v.tone + '.');
  if (v.audience) voiceLines.push('Who they are talking to: ' + v.audience + '.');
  if (v.topics)   voiceLines.push('What they post about: ' + v.topics + '.');
  if (v.avoid)    voiceLines.push('Things to avoid: ' + v.avoid + '.');

  const system =
    "You suggest social media post ideas for one person, tailored to their world. " +
    (voiceLines.length
      ? "Here is who they are:\n" + voiceLines.join("\n") + "\n"
      : "They are a professional building their personal brand. ") +
    "Suggest 5 specific, concrete, ready-to-use post ideas they could post this week. " +
    "Each idea is ONE short sentence a person could hand to a copywriter (e.g. 'Share a quick tip about what to fix before listing your home'). " +
    "Make them varied — mix value/tips, personal/behind-the-scenes, and timely/seasonal angles. " +
    "Return ONLY a JSON array of 5 strings. No markdown, no numbering, no extra text.";

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Give me 5 post ideas.' }] }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'The idea service had a problem. Please try again.' }) };
    }

    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    // Be forgiving about how the model returns the list.
    let ideas = [];
    try {
      const start = raw.indexOf('[');
      const end = raw.lastIndexOf(']');
      const slice = (start !== -1 && end !== -1) ? raw.slice(start, end + 1) : raw;
      ideas = JSON.parse(slice);
    } catch (e) {
      ideas = raw.split('\n')
        .map(s => s.replace(/^[\s\-\*\d\.\)"]+/, '').replace(/"$/, '').trim())
        .filter(Boolean);
    }

    ideas = (Array.isArray(ideas) ? ideas : [])
      .map(s => String(s).trim())
      .filter(Boolean)
      .slice(0, 6);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ideas })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'The idea service is unavailable right now.' }) };
  }
};
