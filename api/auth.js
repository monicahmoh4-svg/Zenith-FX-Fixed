// api/auth.js
// Handles: register, login, google-url, google-callback, logout, me, reset-password
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (action === 'register')         return await handleRegister(req, res);
    if (action === 'login')            return await handleLogin(req, res);
    if (action === 'google-url')       return await handleGoogleUrl(req, res);
    if (action === 'logout')           return await handleLogout(req, res);
    if (action === 'me')               return await handleMe(req, res);
    if (action === 'reset-password')   return await handleResetPassword(req, res);
    if (action === 'update-password')  return await handleUpdatePassword(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`[auth/${action}]`, err);
    return res.status(500).json({ error: err.message || 'Auth error' });
  }
}

// ── REGISTER ─────────────────────────────────────────────────────────────────
async function handleRegister(req, res) {
  const { email, password, firstName, lastName, phone, country } = req.body || {};

  if (!email || !password || !firstName || !lastName)
    return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  // Create Supabase auth user
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: false,   // triggers confirmation email via Supabase
    user_metadata: { firstName, lastName, phone, country },
  });

  if (authErr) {
    if (authErr.message.includes('already registered'))
      return res.status(409).json({ error: 'Email already registered. Please log in.' });
    throw authErr;
  }

  const userId = authData.user.id;

  // Create profile row
  await supabase.from('profiles').upsert({
    id:            userId,
    email,
    first_name:    firstName,
    last_name:     lastName,
    phone:         phone || null,
    country:       country || 'KE',
    demo_balance:  10000.00,
    live_balance:  0.00,
    kyc_status:    'unverified',
    referral_code: genCode(),
    petapips:      0,
    tier:          'bronze',
    created_at:    new Date().toISOString(),
  });

  // Send welcome email
  await sendEmail({
    to: email,
    subject: '🎉 Welcome to Zenith FX!',
    html: welcomeEmail(firstName),
  });

  return res.status(201).json({ success: true, message: 'Account created! Check your email to verify.' });
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });

  if (error) {
    if (error.message.includes('Invalid login'))
      return res.status(401).json({ error: 'Incorrect email or password.' });
    if (error.message.includes('Email not confirmed'))
      return res.status(403).json({ error: 'Please verify your email first. Check your inbox.' });
    throw error;
  }

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', data.user.id).single();

  return res.status(200).json({
    success: true,
    session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at },
    user: profileToUser(data.user, profile),
  });
}

// ── GOOGLE OAUTH URL ──────────────────────────────────────────────────────────
async function handleGoogleUrl(req, res) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const { data, error } = await supabasePublic.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${siteUrl}/api/auth?action=google-callback` },
  });
  if (error) throw error;
  return res.status(200).json({ url: data.url });
}

// ── LOGOUT ────────────────────────────────────────────────────────────────────
async function handleLogout(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.auth.signOut();
  }
  return res.status(200).json({ success: true });
}

// ── ME (get current user profile) ────────────────────────────────────────────
async function handleMe(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Session expired' });

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  return res.status(200).json({ user: profileToUser(user, profile) });
}

// ── RESET PASSWORD ────────────────────────────────────────────────────────────
async function handleResetPassword(req, res) {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const { error } = await supabasePublic.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteUrl}/?page=reset-password`,
  });
  if (error) throw error;
  return res.status(200).json({ success: true, message: 'Password reset email sent.' });
}

async function handleUpdatePassword(req, res) {
  const { password } = req.body || {};
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !password) return res.status(400).json({ error: 'token and password required' });

  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
  return res.status(200).json({ success: true });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function profileToUser(authUser, profile) {
  return {
    id:           authUser.id,
    email:        authUser.email,
    firstName:    profile?.first_name || authUser.user_metadata?.firstName || '',
    lastName:     profile?.last_name  || authUser.user_metadata?.lastName  || '',
    phone:        profile?.phone || '',
    country:      profile?.country || 'KE',
    demoBalance:  profile?.demo_balance || 10000,
    liveBalance:  profile?.live_balance || 0,
    kycStatus:    profile?.kyc_status || 'unverified',
    referralCode: profile?.referral_code || '',
    petapips:     profile?.petapips || 0,
    tier:         profile?.tier || 'bronze',
    avatarUrl:    profile?.avatar_url || authUser.user_metadata?.avatar_url || null,
  };
}

function genCode() {
  return Math.random().toString(36).slice(2, 9).toUpperCase();
}

// ── EMAIL SENDER ──────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({ from: process.env.SMTP_FROM, to, subject, html });
}

function welcomeEmail(name) {
  return `
  <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#0d1117;color:#e6edf3;border-radius:12px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#1f9cf0,#22d3ee);padding:2rem;text-align:center">
      <div style="font-size:2.5rem;font-weight:900;color:#fff;letter-spacing:-1px">Zenith FX</div>
    </div>
    <div style="padding:2rem">
      <h2 style="margin:0 0 1rem;font-size:1.4rem">Welcome, ${name}! 🎉</h2>
      <p style="color:#8b949e;line-height:1.7">Your Zenith FX account is ready. You have <strong style="color:#3fb950">$10,000 demo balance</strong> to start practicing.</p>
      <div style="margin:1.5rem 0;background:#161b22;border-radius:8px;padding:1rem">
        <div style="color:#8b949e;font-size:.85rem;margin-bottom:.4rem">Your demo balance</div>
        <div style="font-size:1.8rem;font-weight:800;color:#3fb950">$10,000.00</div>
      </div>
      <p style="color:#8b949e;line-height:1.7">Ready to go live? Deposit via <strong style="color:#fff">M-Pesa</strong> from as little as <strong style="color:#fff">KES 100</strong>.</p>
      <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://zenithfx.vercel.app'}" style="display:inline-block;margin-top:1.5rem;background:linear-gradient(135deg,#1f9cf0,#38bdf8);color:#fff;font-weight:700;padding:.85rem 2rem;border-radius:8px;text-decoration:none;font-size:.95rem">Start Trading →</a>
    </div>
    <div style="padding:1rem 2rem 1.5rem;text-align:center;color:#6e7681;font-size:.78rem;border-top:1px solid #21262d">
      Zenith FX Limited · support@zenithfx.io<br>
      ⚠️ Trading involves risk. Never invest money you can't afford to lose.
    </div>
  </div>`;
}
