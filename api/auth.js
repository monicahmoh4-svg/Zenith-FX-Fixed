// api/auth.js — Zenith FX Auth (fixed)
// All clients created inside handlers to avoid cold-start crashes

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (action === 'register')        return await handleRegister(req, res);
    if (action === 'login')           return await handleLogin(req, res);
    if (action === 'google-url')      return await handleGoogleUrl(req, res);
    if (action === 'logout')          return await handleLogout(req, res);
    if (action === 'me')              return await handleMe(req, res);
    if (action === 'reset-password')  return await handleResetPassword(req, res);
    if (action === 'update-password') return await handleUpdatePassword(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`[auth/${action}] UNHANDLED:`, err?.message, err?.stack);
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function getServiceClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var missing');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function getPublicClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_ANON_KEY env var missing');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function genCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function profileToUser(authUser, profile) {
  return {
    id:           authUser.id,
    email:        authUser.email,
    firstName:    profile?.first_name  || authUser.user_metadata?.firstName  || authUser.user_metadata?.given_name  || '',
    lastName:     profile?.last_name   || authUser.user_metadata?.lastName   || authUser.user_metadata?.family_name || '',
    phone:        profile?.phone       || authUser.user_metadata?.phone       || '',
    country:      profile?.country     || authUser.user_metadata?.country     || 'KE',
    demoBalance:  parseFloat(profile?.demo_balance  || 10000),
    liveBalance:  parseFloat(profile?.live_balance  || 0),
    kycStatus:    profile?.kyc_status  || 'unverified',
    referralCode: profile?.referral_code || '',
    petapips:     parseInt(profile?.petapips || 0),
    tier:         profile?.tier        || 'bronze',
    avatarUrl:    profile?.avatar_url  || authUser.user_metadata?.avatar_url || null,
  };
}

// ── REGISTER ─────────────────────────────────────────────────────────────────
async function handleRegister(req, res) {
  const { email, password, firstName, lastName, phone, country } = req.body || {};

  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({ error: 'First name, last name, email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const supabase = getServiceClient();

  // Check if email already exists
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email.toLowerCase().trim())
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
  }

  // Create auth user — email_confirm: true means Supabase sends confirmation email
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email:          email.toLowerCase().trim(),
    password,
    email_confirm:  false, // set true to require email verification before login
    user_metadata:  { firstName, lastName, phone: phone || null, country: country || 'KE' },
  });

  if (authErr) {
    console.error('[register] supabase.auth.admin.createUser error:', authErr);
    if (authErr.message?.toLowerCase().includes('already')) {
      return res.status(409).json({ error: 'Email already registered. Please log in.' });
    }
    return res.status(400).json({ error: authErr.message || 'Could not create account.' });
  }

  const userId = authData.user.id;
  const referralCode = genCode();

  // Upsert profile row (trigger may have already created it)
  const { error: profileErr } = await supabase.from('profiles').upsert({
    id:            userId,
    email:         email.toLowerCase().trim(),
    first_name:    firstName,
    last_name:     lastName,
    phone:         phone || null,
    country:       country || 'KE',
    demo_balance:  10000.00,
    live_balance:  0.00,
    kyc_status:    'unverified',
    referral_code: referralCode,
    petapips:      0,
    tier:          'bronze',
    created_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'id' });

  if (profileErr) {
    console.error('[register] profile upsert error:', profileErr);
    // Not fatal — trigger may have already created the profile
  }

  // Send welcome email — wrapped in try/catch so email failure doesn't break registration
  try {
    await sendWelcomeEmail(email, firstName);
  } catch (emailErr) {
    console.error('[register] welcome email failed (non-fatal):', emailErr.message);
  }

  return res.status(201).json({
    success: true,
    message: 'Account created successfully! You can now log in.',
  });
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const supabase = getPublicClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.toLowerCase().trim(),
    password,
  });

  if (error) {
    console.error('[login] error:', error.message);
    if (error.message?.includes('Invalid login') || error.message?.includes('invalid_credentials')) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    if (error.message?.includes('Email not confirmed')) {
      return res.status(403).json({ error: 'Please verify your email first. Check your inbox.' });
    }
    return res.status(401).json({ error: error.message || 'Login failed.' });
  }

  // Fetch profile
  const sb2 = getServiceClient();
  const { data: profile } = await sb2
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .maybeSingle();

  // If profile missing (edge case), create it
  if (!profile) {
    await sb2.from('profiles').upsert({
      id:            data.user.id,
      email:         data.user.email,
      first_name:    data.user.user_metadata?.firstName || data.user.user_metadata?.given_name || '',
      last_name:     data.user.user_metadata?.lastName  || data.user.user_metadata?.family_name || '',
      demo_balance:  10000.00,
      live_balance:  0.00,
      kyc_status:    'unverified',
      referral_code: genCode(),
      petapips:      0,
      tier:          'bronze',
    }, { onConflict: 'id' });
  }

  return res.status(200).json({
    success: true,
    session: {
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at:    data.session.expires_at,
    },
    user: profileToUser(data.user, profile),
  });
}

// ── GOOGLE OAUTH URL ──────────────────────────────────────────────────────────
async function handleGoogleUrl(req, res) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const supabase = getPublicClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options:  { redirectTo: `${siteUrl}/` },
  });
  if (error) throw error;
  return res.status(200).json({ url: data.url });
}

// ── LOGOUT ────────────────────────────────────────────────────────────────────
async function handleLogout(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth:   { autoRefreshToken: false, persistSession: false },
      });
      await client.auth.signOut();
    } catch (e) { /* ignore */ }
  }
  return res.status(200).json({ success: true });
}

// ── ME ────────────────────────────────────────────────────────────────────────
async function handleMe(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const supabase = getServiceClient();
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Session expired. Please log in again.' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  return res.status(200).json({ user: profileToUser(user, profile) });
}

// ── RESET PASSWORD ────────────────────────────────────────────────────────────
async function handleResetPassword(req, res) {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const siteUrl  = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const supabase = getPublicClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.toLowerCase().trim(), {
    redirectTo: `${siteUrl}/?page=reset-password`,
  });
  if (error) throw error;
  return res.status(200).json({ success: true, message: 'Password reset email sent.' });
}

// ── UPDATE PASSWORD ───────────────────────────────────────────────────────────
async function handleUpdatePassword(req, res) {
  const { password } = req.body || {};
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token)         return res.status(401).json({ error: 'Not authenticated.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
  return res.status(200).json({ success: true });
}

// ── WELCOME EMAIL ─────────────────────────────────────────────────────────────
async function sendWelcomeEmail(toEmail, firstName) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.warn('[email] SMTP env vars not set — skipping welcome email');
    return;
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth:   { user, pass },
    tls:    { rejectUnauthorized: false },
  });

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://zenithfx.vercel.app';

  await transporter.sendMail({
    from:    process.env.SMTP_FROM || `"Zenith FX" <${user}>`,
    to:      toEmail,
    subject: '🎉 Welcome to Zenith FX — Your account is ready',
    html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0d1117;color:#e6edf3;border-radius:12px;overflow:hidden;border:1px solid #30363d">
  <div style="background:linear-gradient(135deg,#1f9cf0,#22d3ee);padding:1.6rem 2rem">
    <div style="font-size:1.5rem;font-weight:900;color:#fff;letter-spacing:-0.5px">Zenith FX</div>
    <div style="font-size:.85rem;color:rgba(255,255,255,.8);margin-top:.25rem">Trade Smart, Rise Higher</div>
  </div>
  <div style="padding:2rem">
    <h2 style="margin:0 0 .9rem;font-size:1.3rem;font-weight:700">Welcome, ${firstName}! 🎉</h2>
    <p style="color:#8b949e;line-height:1.7;margin-bottom:1rem">Your Zenith FX account is ready. You have a <strong style="color:#3fb950">$10,000 demo balance</strong> to start practicing immediately — no deposit needed.</p>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1.4rem">
      <div style="font-size:.75rem;color:#8b949e;margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.5px">Demo Balance</div>
      <div style="font-size:1.6rem;font-weight:800;color:#3fb950;font-family:monospace">$10,000.00</div>
    </div>
    <p style="color:#8b949e;line-height:1.7;margin-bottom:1.4rem">Ready to go live? Deposit via <strong style="color:#fff">M-Pesa</strong> from as little as <strong style="color:#fff">KES 100</strong>.</p>
    <a href="${siteUrl}" style="display:inline-block;background:linear-gradient(135deg,#1f9cf0,#38bdf8);color:#fff;font-weight:700;padding:.8rem 1.8rem;border-radius:8px;text-decoration:none;font-size:.92rem">Start Trading →</a>
  </div>
  <div style="padding:.9rem 2rem 1.3rem;text-align:center;color:#6e7681;font-size:.72rem;border-top:1px solid #21262d">
    Zenith FX Limited · support@zenithfx.io<br>
    ⚠️ Trading involves risk. Never invest money you cannot afford to lose.
  </div>
</div>`,
  });
}
