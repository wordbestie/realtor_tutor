// generate-caption.js
// Turns an agent's brief (+ optional image) into a ready-to-post social caption
// using Claude. Server-side so members never need their own AI key for the in-RT flow.
//
// Requires a Netlify environment variable: ANTHROPIC_API_KEY  (your Anthropic key)

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

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

  // Optional image for context: { media_type: 'image/jpeg', data: '<base64>' }
  const image = body.image && body.image.data && body.image.media_type ? body.image : null;

  const system =
    "You are a social media copywriter for an individual real estate agent. " +
    "Write ONE ready-to-post caption based on the agent's brief (and the image, if provided). " +
    "Tone: warm, professional, and authentic — never salesy, hype-y, or spammy. " +
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
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'The caption service had a problem. Please try again.' })
      };
    }

    const caption = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caption })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'The caption service is unavailable right now.' }) };
  }
};
