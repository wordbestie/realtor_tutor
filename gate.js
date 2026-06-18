/* ================================================================
   Realtor Tutor — shared auth config + wizard access gate
   ----------------------------------------------------------------
   PASTE YOUR PUBLIC SUPABASE VALUES HERE (and nowhere else).
   Both index.html and every wizard read from this one file.
   These two values are safe to expose publicly.
   ================================================================ */
window.RT_SUPABASE_URL      = 'YOUR_SUPABASE_URL';
window.RT_SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// While the keys are placeholders, the whole site runs in DEMO MODE
// (everything is clickable, nothing is actually checked). Real keys
// flip it to live auth + the wizard gate below.
window.RT_DEMO_MODE =
  window.RT_SUPABASE_URL.includes('YOUR_') ||
  window.RT_SUPABASE_ANON_KEY.includes('YOUR_');

/* requireMemberAccess() — used by each wizard page.
   Returns true if the visitor is signed in AND has paid; otherwise it
   sends them back to the homepage to sign in / buy. In demo mode it
   always returns true so you can preview the wizards.
   It fails CLOSED: any error redirects home, so the wizard never opens
   for someone we couldn't verify. */
window.requireMemberAccess = async function (opts) {
  const home = (opts && opts.home) ? opts.home : '../index.html';
  if (window.RT_DEMO_MODE) return true;
  try {
    let createClient;
    const cdns = [
      'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.0/+esm',
      'https://esm.sh/@supabase/supabase-js@2.45.0'
    ];
    for (const u of cdns) {
      try { const m = await import(u); if (m && m.createClient) { createClient = m.createClient; break; } }
      catch (e) { /* try next CDN */ }
    }
    if (!createClient) { location.replace(home); return false; }
    const sb = createClient(window.RT_SUPABASE_URL, window.RT_SUPABASE_ANON_KEY, {
      auth: { persistSession:true, autoRefreshToken:true,
              lock: (name, acquireTimeout, fn) => fn() }   // bypass navigator.locks (prevents silent hangs)
    });
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { location.replace(home); return false; }
    const { data } = await sb
      .from('entitlements')
      .select('has_access')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (data && data.has_access) return true;
    location.replace(home);
    return false;
  } catch (e) {
    location.replace(home);
    return false;
  }
};
