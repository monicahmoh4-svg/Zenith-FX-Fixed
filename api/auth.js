// api/auth.js — Zenith FX Auth v3
// Uses signUp() so Supabase sends its own confirmation email automatically.
// Requires in Supabase Dashboard → Authentication → Email Templates → confirm the redirect URL.

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
    if (action === 'update-password')      return await handleUpdatePassword(req, res);
    if (action === 'resend-verification')  return await handleResendVerification(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`[auth/${action}] UNHANDLED:`, err?.message, err?.stack);
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  }
}

// ── CLIENT HELPERS ────────────────────────────────────────────────────────────
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
    demoBalance:  parseFloat(profile?.demo_balance ?? 10000),
    liveBalance:  parseFloat(profile?.live_balance ?? 0),
    kycStatus:    profile?.kyc_status  || 'unverified',
    referralCode: profile?.referral_code || '',
    petapips:     parseInt(profile?.petapips || 0),
    tier:         profile?.tier        || 'bronze',
    avatarUrl:    profile?.avatar_url  || authUser.user_metadata?.avatar_url || null,
  };
}

// ── REGISTER ──────────────────────────────────────────────────────────────────
// Uses the PUBLIC client signUp() — this is the ONLY way Supabase sends
// the confirmation email automatically from its own email system.
async function handleRegister(req, res) {
  const { email, password, firstName, lastName, phone, country } = req.body || {};

  // ── validation ──
  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({ error: 'First name, last name, email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const siteUrl   = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;

  // Use PUBLIC client signUp() — Supabase automatically:
  //   1. Creates the auth user
  //   2. Sends a confirmation email with a magic link
  //   3. The link redirects to emailRedirectTo after confirmation
  const publicClient = getPublicClient();
  const { data: signUpData, error: signUpError } = await publicClient.auth.signUp({
    email:    cleanEmail,
    password,
    options: {
      // This is the URL the confirmation link in the email redirects to
      emailRedirectTo: `${siteUrl}/`,
      // Store extra metadata — also available as user_metadata
      data: {
        firstName,
        lastName,
        phone:   phone   || null,
        country: country || 'KE',
      },
    },
  });

  if (signUpError) {
    console.error('[register] signUp error:', signUpError);
    // Supabase returns this when the email is already registered
    if (
      signUpError.message?.toLowerCase().includes('already registered') ||
      signUpError.message?.toLowerCase().includes('user already registered') ||
      signUpError.status === 422
    ) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    }
    return res.status(400).json({ error: signUpError.message || 'Registration failed.' });
  }

  // signUpData.user will exist even before confirmation.
  // signUpData.session will be null if email confirmation is required.
  const userId = signUpData?.user?.id;

  if (!userId) {
    // Should not happen, but guard anyway
    return res.status(500).json({ error: 'Account creation failed. Please try again.' });
  }

  // Upsert the profile row immediately using the service client.
  // The DB trigger (handle_new_user) may also do this — upsert is safe either way.
  const serviceClient = getServiceClient();
  const { error: profileErr } = await serviceClient.from('profiles').upsert({
    id:            userId,
    email:         cleanEmail,
    first_name:    firstName,
    last_name:     lastName,
    phone:         phone    || null,
    country:       country  || 'KE',
    demo_balance:  10000.00,
    live_balance:  0.00,
    kyc_status:    'unverified',
    referral_code: genCode(),
    petapips:      0,
    tier:          'bronze',
    created_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'id' });

  if (profileErr) {
    // Non-fatal — log but don't fail the registration
    console.error('[register] profile upsert error (non-fatal):', profileErr.message);
  }

  // Send our own branded welcome email IN ADDITION to Supabase's confirmation email.
  // Wrapped in try/catch — SMTP failure must never break registration.
  try {
    await sendWelcomeEmail(cleanEmail, firstName, siteUrl);
  } catch (emailErr) {
    console.error('[register] welcome email failed (non-fatal):', emailErr.message);
  }

  return res.status(201).json({
    success: true,
    // Tell the frontend whether the user still needs to verify their email.
    // session is null  → email confirmation required (standard flow)
    // session exists   → email confirmation disabled in Supabase (auto-login)
    requiresVerification: !signUpData?.session,
    message: signUpData?.session
      ? 'Account created! You are now logged in.'
      : 'Account created! Please check your email and click the confirmation link to activate your account.',
  });
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const publicClient = getPublicClient();
  const { data, error } = await publicClient.auth.signInWithPassword({
    email:    email.toLowerCase().trim(),
    password,
  });

  if (error) {
    console.error('[login] error:', error.message);
    if (
      error.message?.includes('Invalid login') ||
      error.message?.includes('invalid_credentials') ||
      error.message?.includes('Invalid email or password')
    ) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    if (error.message?.includes('Email not confirmed')) {
      return res.status(403).json({
        error: 'Please verify your email first. Check your inbox for a confirmation link.',
        code:  'EMAIL_NOT_CONFIRMED',
      });
    }
    return res.status(401).json({ error: error.message || 'Login failed.' });
  }

  // Fetch profile from our profiles table
  const serviceClient = getServiceClient();
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .maybeSingle();

  // Profile may not exist yet if trigger hasn't run — create it
  if (!profile) {
    const meta = data.user.user_metadata || {};
    await serviceClient.from('profiles').upsert({
      id:            data.user.id,
      email:         data.user.email,
      first_name:    meta.firstName || meta.given_name  || '',
      last_name:     meta.lastName  || meta.family_name || '',
      phone:         meta.phone     || null,
      country:       meta.country   || 'KE',
      demo_balance:  10000.00,
      live_balance:  0.00,
      kyc_status:    'unverified',
      referral_code: genCode(),
      petapips:      0,
      tier:          'bronze',
      updated_at:    new Date().toISOString(),
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
  const siteUrl      = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const publicClient = getPublicClient();
  const { data, error } = await publicClient.auth.signInWithOAuth({
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
      const client = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
        {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth:   { autoRefreshToken: false, persistSession: false },
        }
      );
      await client.auth.signOut();
    } catch (e) { /* ignore — token may already be expired */ }
  }
  return res.status(200).json({ success: true });
}

// ── ME ────────────────────────────────────────────────────────────────────────
async function handleMe(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const serviceClient = getServiceClient();
  const { data: { user }, error } = await serviceClient.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  const { data: profile } = await serviceClient
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

  const siteUrl      = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const publicClient = getPublicClient();
  const { error } = await publicClient.auth.resetPasswordForEmail(
    email.toLowerCase().trim(),
    { redirectTo: `${siteUrl}/?page=reset-password` }
  );
  if (error) throw error;
  return res.status(200).json({ success: true, message: 'Password reset email sent.' });
}

// ── UPDATE PASSWORD ───────────────────────────────────────────────────────────
async function handleUpdatePassword(req, res) {
  const { password } = req.body || {};
  const token        = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth:   { autoRefreshToken: false, persistSession: false },
    }
  );
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
  return res.status(200).json({ success: true });
}

// ── RESEND VERIFICATION EMAIL ────────────────────────────────────────────────
async function handleResendVerification(req, res) {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const siteUrl      = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const publicClient = getPublicClient();

  // Calling signUp again on an existing unconfirmed user resends the confirmation email
  const { error } = await publicClient.auth.resend({
    type:  'signup',
    email: email.toLowerCase().trim(),
    options: { emailRedirectTo: `${siteUrl}/` },
  });

  if (error) {
    console.error('[resend-verification]', error.message);
    // Don't expose whether the email exists — just say it was sent
    return res.status(200).json({ success: true, message: 'If that email is registered, a confirmation link has been sent.' });
  }

  return res.status(200).json({ success: true, message: 'Confirmation email resent. Check your inbox and spam folder.' });
}

// ── WELCOME EMAIL (branded, sent alongside Supabase's confirmation email) ─────
async function sendWelcomeEmail(toEmail, firstName, siteUrl) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.warn('[email] SMTP env vars not configured — skipping welcome email');
    return;
  }

  const nodemailer  = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host:   smtpHost,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth:   { user: smtpUser, pass: smtpPass },
    tls:    { rejectUnauthorized: false },
  });

  await transporter.sendMail({
    from:    process.env.SMTP_FROM || `"Zenith FX" <${smtpUser}>`,
    to:      toEmail,
    subject: '🎉 Welcome to Zenith FX — Confirm your email to get started',
    html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0d1117;color:#e6edf3;border-radius:12px;overflow:hidden;border:1px solid #30363d">
  <div style="background:linear-gradient(135deg,#1f9cf0,#22d3ee);padding:1.6rem 2rem">
    <div style="font-size:1.5rem;font-weight:900;color:#fff;letter-spacing:-0.5px">Zenith FX</div>
    <div style="font-size:.85rem;color:rgba(255,255,255,.8);margin-top:.2rem">Trade Smart, Rise Higher</div>
  </div>
  <div style="padding:2rem">
    <h2 style="margin:0 0 .9rem;font-size:1.2rem;font-weight:700">Welcome, ${firstName}! 🎉</h2>
    <p style="color:#8b949e;line-height:1.7;margin-bottom:1rem">
      Your Zenith FX account has been created. You will receive a separate email from us with a
      <strong style="color:#fff">confirmation link</strong> — click it to activate your account and log in.
    </p>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1.4rem">
      <div style="font-size:.72rem;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.3rem">Demo Balance Ready</div>
      <div style="font-size:1.5rem;font-weight:800;color:#3fb950;font-family:monospace">$10,000.00</div>
      <div style="font-size:.75rem;color:#8b949e;margin-top:.2rem">Available immediately after email confirmation</div>
    </div>
    <p style="color:#8b949e;line-height:1.7;margin-bottom:1.4rem">
      After confirming, you can deposit via <strong style="color:#fff">M-Pesa</strong> from as little as <strong style="color:#fff">KES 100</strong> to start live trading.
    </p>
    <a href="${siteUrl}" style="display:inline-block;background:linear-gradient(135deg,#1f9cf0,#38bdf8);color:#fff;font-weight:700;padding:.8rem 1.8rem;border-radius:8px;text-decoration:none;font-size:.9rem">
      Go to Zenith FX →
    </a>
  </div>
  <div style="padding:.9rem 2rem 1.2rem;text-align:center;color:#6e7681;font-size:.7rem;border-top:1px solid #21262d">
    Zenith FX Limited · support@zenithfx.io<br>
    ⚠️ Trading involves risk. Never invest money you cannot afford to lose.
  </div>
</div>`,
  });
}
