// ─────────────────────────────────────────────────────────────
//  TRINGG — Google Business Profile OAuth Server
//  Local:   node server.js  → http://localhost:3000
//  Railway: auto-deployed via GitHub push
// ─────────────────────────────────────────────────────────────

// dotenv only loads in local dev — Railway injects env vars directly
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  PORT = 3000,

  // On Railway: set this to your Railway public URL e.g.
  // https://tringg-gbp-test-production.up.railway.app/auth/google/callback
  // On local: http://localhost:3000/auth/google/callback
  REDIRECT_URI,

  // Railway injects RAILWAY_PUBLIC_DOMAIN automatically
  RAILWAY_PUBLIC_DOMAIN,
} = process.env;

// Build redirect URI — prefer explicit env var, fallback to Railway domain
function getRedirectURI() {
  if (REDIRECT_URI) return REDIRECT_URI;
  if (RAILWAY_PUBLIC_DOMAIN) {
    return `https://${RAILWAY_PUBLIC_DOMAIN}/auth/google/callback`;
  }
  return `http://localhost:${PORT}/auth/google/callback`;
}

// ─── In-memory token store ────────────────────────────────────
const tokenStore = {};

// Auto-clean tokens older than 2 hours
setInterval(() => {
  const twoHoursAgo = Date.now() - 7200000;
  Object.keys(tokenStore).forEach(key => {
    if (tokenStore[key].created_at < twoHoursAgo) delete tokenStore[key];
  });
}, 3600000);

// ─────────────────────────────────────────────────────────────
//  ROUTE 1: Start OAuth
// ─────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
    return res.status(500).send(`
      <h2 style="font-family:sans-serif">GOOGLE_CLIENT_ID not set</h2>
      <p style="font-family:sans-serif">Go to Railway project → Variables and add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET</p>
    `);
  }

  const sessionId   = 'tringg-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const redirectURI = getRedirectURI();

  const scopes = [
    'https://www.googleapis.com/auth/business.manage',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' ');

  const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  googleAuthUrl.searchParams.set('client_id',     GOOGLE_CLIENT_ID);
  googleAuthUrl.searchParams.set('redirect_uri',  redirectURI);
  googleAuthUrl.searchParams.set('response_type', 'code');
  googleAuthUrl.searchParams.set('scope',         scopes);
  googleAuthUrl.searchParams.set('access_type',   'offline');
  googleAuthUrl.searchParams.set('prompt',        'consent');
  googleAuthUrl.searchParams.set('state',         sessionId);

  console.log('[Auth] Starting OAuth. Redirect URI:', redirectURI);
  res.redirect(googleAuthUrl.toString());
});

// ─────────────────────────────────────────────────────────────
//  ROUTE 2: OAuth Callback
// ─────────────────────────────────────────────────────────────
app.get('/auth/google/callback', async (req, res) => {
  const { code, state: sessionId, error } = req.query;

  if (error) {
    console.log('[Auth] User denied access:', error);
    return res.redirect('/?error=access_denied');
  }

  if (!code) return res.redirect('/?error=no_code');

  try {
    console.log('[Auth] Exchanging code for token...');

    const tokenResponse = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  getRedirectURI(),
        grant_type:    'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    console.log('[Auth] Token received. Expires in:', expires_in, 'sec');

    tokenStore[sessionId] = { access_token, refresh_token, created_at: Date.now() };

    res.redirect(`/?session=${encodeURIComponent(sessionId)}&step=fetch`);

  } catch (err) {
    console.error('[Auth] Token exchange failed:', err.response?.data || err.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

// ─────────────────────────────────────────────────────────────
//  ROUTE 3: Fetch GBP profile
// ─────────────────────────────────────────────────────────────
app.get('/api/gbp/profile', async (req, res) => {
  const { session } = req.query;

  if (!session || !tokenStore[session]) {
    return res.status(401).json({
      error: 'Session expired or not found.',
      hint: 'Please click Import from Google again to re-authenticate.'
    });
  }

  const { access_token } = tokenStore[session];

  try {
    // Step 1 — Get accounts
    const accountsRes = await axios.get(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    const accounts = accountsRes.data.accounts || [];
    if (accounts.length === 0) {
      return res.status(404).json({
        error: 'No Google Business Profile found for this account.',
        hint: 'Make sure this Google account manages at least one business on Google Maps.'
      });
    }

    const accountName = accounts[0].name;

    // Step 2 — Get locations
    const locationsRes = await axios.get(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
        params: {
          readMask: [
            'name', 'title', 'phoneNumbers', 'regularHours',
            'categories', 'storefrontAddress', 'websiteUri', 'profile',
          ].join(','),
          pageSize: 20,
        }
      }
    );

    const locations = locationsRes.data.locations || [];
    if (locations.length === 0) {
      return res.status(404).json({
        error: 'No business locations found.',
        hint: 'This account has no registered locations on Google Business Profile.'
      });
    }

    console.log(`[GBP] Found ${locations.length} location(s)`);

    res.json({
      success:   true,
      count:     locations.length,
      locations: locations.map(loc => mapGBPToTringg(loc)),
      raw_first: locations[0],
    });

  } catch (err) {
    const apiError = err.response?.data;
    console.error('[GBP] Error:', JSON.stringify(apiError) || err.message);

    if (err.response?.status === 403) {
      return res.status(403).json({
        error: 'Permission denied by Google.',
        hint: 'Make sure both My Business APIs are enabled in Google Cloud Console.',
        details: apiError
      });
    }
    if (err.response?.status === 401) {
      return res.status(401).json({
        error: 'Token expired. Please re-authenticate.',
        details: apiError
      });
    }

    res.status(500).json({ error: 'GBP API error.', details: apiError || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  ROUTE 4: Status check
// ─────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    configured:        !!GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== 'YOUR_CLIENT_ID_HERE',
    client_id_set:     !!GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== 'YOUR_CLIENT_ID_HERE',
    client_secret_set: !!GOOGLE_CLIENT_SECRET && GOOGLE_CLIENT_SECRET !== 'YOUR_CLIENT_SECRET_HERE',
    redirect_uri:      getRedirectURI(),
    environment:       process.env.NODE_ENV || 'development',
    active_sessions:   Object.keys(tokenStore).length,
  });
});

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────
function mapGBPToTringg(loc) {
  const addr = loc.storefrontAddress;
  const address = addr
    ? [
        addr.addressLines?.join(', '),
        addr.locality,
        addr.administrativeArea,
        addr.postalCode,
        addr.regionCode,
      ].filter(Boolean).join(', ')
    : null;

  return {
    restaurant_name:  loc.title || null,
    phone_number:     loc.phoneNumbers?.primaryPhone || null,
    address,
    cuisine_type:     loc.categories?.primaryCategory?.displayName || null,
    all_categories:   (loc.categories?.additionalCategories || []).map(c => c.displayName),
    operating_hours:  formatHours(loc.regularHours?.periods || []),
    website:          loc.websiteUri || null,
    description:      loc.profile?.description || null,
    gbp_location_id:  loc.name,
    import_source:    'google_business_profile',
    imported_at:      new Date().toISOString(),
  };
}

function formatHours(periods) {
  const dayMap = {
    MONDAY: 'Mon', TUESDAY: 'Tue', WEDNESDAY: 'Wed',
    THURSDAY: 'Thu', FRIDAY: 'Fri', SATURDAY: 'Sat', SUNDAY: 'Sun'
  };
  const schedule = {};
  for (const p of periods) {
    const day = dayMap[p.openDay] || p.openDay;
    if (!schedule[day]) schedule[day] = [];
    schedule[day].push(`${formatTime(p.openTime)} – ${formatTime(p.closeTime)}`);
  }
  return schedule;
}

function formatTime(t) {
  if (!t) return '?';
  const h = t.hours || 0;
  const m = t.minutes || 0;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Tringg GBP Server');
  console.log(`  Port:        ${PORT}`);
  console.log(`  Redirect:    ${getRedirectURI()}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
