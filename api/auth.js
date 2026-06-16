// api/auth.js — Zenith FX Auth v4 (production-ready)
// Fixes: reset password error {}, phone OTP, Google OAuth, resend verification

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (action === 'register')             return await handleRegister(req, res);
    if (action === 'login')                return await handleLogin(req, res);
    if (action === 'google-url')           return await handleGoogleUrl(req, res);
    if (action === 'phone-otp-send')       return await handlePhoneOtpSend(req, res);
    if (action === 'phone-otp-verify')     return await handlePhoneOtpVerify(req, res);
    if (action === 'logout')               return await handleLogout(req, res);
    if (action === 'me')                   return await handleMe(req, res);
    if (action === 'reset-password')       return await handleResetPassword(req, res);
    if (action === 'update-password')      return await handleUpdatePassword(req, res);
    if (action === 'resend-verification')  return await handleResendVerification(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    // Supabase errors are plain objects, not Error instances — normalise here
    const message = err?.message || err?.error_description || err?.msg || JSON.stringify(err);
    console.error(`[auth/${action}] UNHANDLED:`, message);
    return res.status(500).json({ error: message || 'Internal server error' });
  }
}

// ── CLIENT FACTORIES ──────────────────────────────────────────────────────────
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

// Normalise a Supabase error object into a plain string
function sbErr(error) {
  if (!error) return null;
  return error.message || error.error_description || error.msg || JSON.stringify(error);
}

function genCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function profileToUser(authUser, profile) {
  return {
    id:           authUser.id,
    email:        authUser.email,
    phone:        profile?.phone       || authUser.phone || authUser.user_metadata?.phone || '',
    firstName:    profile?.first_name  || authUser.user_metadata?.firstName  || authUser.user_metadata?.given_name  || '',
    lastName:     profile?.last_name   || authUser.user_metadata?.lastName   || authUser.user_metadata?.family_name || '',
    country:      profile?.country     || authUser.user_metadata?.country     || 'KE',
    demoBalance:  parseFloat(profile?.demo_balance ?? 10000),
    liveBalance:  parseFloat(profile?.live_balance  ?? 0),
    kycStatus:    profile?.kyc_status  || 'unverified',
    referralCode: profile?.referral_code || '',
    petapips:     parseInt(profile?.petapips || 0),
    tier:         profile?.tier        || 'bronze',
    avatarUrl:    profile?.avatar_url  || authUser.user_metadata?.avatar_url || null,
  };
}

async function upsertProfile(userId, fields) {
  const sb = getServiceClient();
  const { error } = await sb.from('profiles').upsert(
    { id: userId, updated_at: new Date().toISOString(), ...fields },
    { onConflict: 'id' }
  );
  if (error) console.error('[upsertProfile] non-fatal:', sbErr(error));
}

// ── REGISTER (email + password) ───────────────────────────────────────────────
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

  const cleanEmail = email.toLowerCase().trim();
  const siteUrl   = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const pub       = getPublicClient();

  const { data: signUpData, error: signUpError } = await pub.auth.signUp({
    email:    cleanEmail,
    password,
    options: {
      emailRedirectTo: `${siteUrl}/`,
      data: { firstName, lastName, phone: phone || null, country: country || 'KE' },
    },
  });

  if (signUpError) {
    const msg = sbErr(signUpError);
    console.error('[register] signUp error:', msg);
    if (
      signUpError.status === 422 ||
      msg?.toLowerCase().includes('already registered') ||
      msg?.toLowerCase().includes('user already registered')
    ) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    }
    return res.status(400).json({ error: msg || 'Registration failed.' });
  }

  const userId = signUpData?.user?.id;
  if (!userId) {
    return res.status(500).json({ error: 'Account creation failed. Please try again.' });
  }

  await upsertProfile(userId, {
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
  });

  // Send branded welcome email alongside Supabase's confirmation email
  try { await sendWelcomeEmail(cleanEmail, firstName, siteUrl); }
  catch (e) { console.error('[register] welcome email failed (non-fatal):', e.message); }

  return res.status(201).json({
    success: true,
    requiresVerification: !signUpData?.session,
    message: signUpData?.session
      ? 'Account created! You are now logged in.'
      : 'Account created! Please check your email and click the confirmation link to activate your account.',
  });
}

// ── LOGIN (email + password) ──────────────────────────────────────────────────
async function handleLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const pub = getPublicClient();
  const { data, error } = await pub.auth.signInWithPassword({
    email:    email.toLowerCase().trim(),
    password,
  });

  if (error) {
    const msg = sbErr(error);
    console.error('[login] error:', msg);
    if (msg?.includes('Invalid login') || msg?.includes('invalid_credentials') || msg?.includes('Invalid email')) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    if (msg?.includes('Email not confirmed') || msg?.includes('not confirmed')) {
      return res.status(403).json({
        error: 'Please verify your email first. Click the confirmation link we sent you.',
        code:  'EMAIL_NOT_CONFIRMED',
      });
    }
    return res.status(401).json({ error: msg || 'Login failed.' });
  }

  const sb = getServiceClient();
  let { data: profile } = await sb.from('profiles').select('*').eq('id', data.user.id).maybeSingle();

  if (!profile) {
    const meta = data.user.user_metadata || {};
    await upsertProfile(data.user.id, {
      email:         data.user.email,
      first_name:    meta.firstName || meta.given_name  || '',
      last_name:     meta.lastName  || meta.family_name || '',
      phone:         meta.phone     || data.user.phone  || null,
      country:       meta.country   || 'KE',
      demo_balance:  10000.00,
      live_balance:  0.00,
      kyc_status:    'unverified',
      referral_code: genCode(),
      petapips:      0,
      tier:          'bronze',
      created_at:    new Date().toISOString(),
    });
    const { data: p2 } = await sb.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
    profile = p2;
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

// ── GOOGLE OAUTH — returns redirect URL ──────────────────────────────────────
async function handleGoogleUrl(req, res) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const pub     = getPublicClient();
  const { data, error } = await pub.auth.signInWithOAuth({
    provider: 'google',
    options:  { redirectTo: `${siteUrl}/` },
  });
  if (error) {
    return res.status(500).json({ error: sbErr(error) || 'Google OAuth failed.' });
  }
  return res.status(200).json({ url: data.url });
}

// ── PHONE OTP — send ─────────────────────────────────────────────────────────
// Requires Twilio/MessageBird configured in Supabase Dashboard → Auth → Phone
async function handlePhoneOtpSend(req, res) {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });

  // Normalise to E.164 format: +254XXXXXXXXX
  let clean = String(phone).replace(/\D/g, '');
  if (clean.startsWith('0'))  clean = '254' + clean.slice(1);
  if (!clean.startsWith('+')) clean = '+' + clean;

  const pub = getPublicClient();
  const { error } = await pub.auth.signInWithOtp({
    phone: clean,
    options: { channel: 'sms' },
  });

  if (error) {
    const msg = sbErr(error);
    console.error('[phone-otp-send]', msg);
    return res.status(400).json({ error: msg || 'Failed to send OTP. Check the phone number.' });
  }

  return res.status(200).json({ success: true, message: `OTP sent to ${clean}` });
}

// ── PHONE OTP — verify ────────────────────────────────────────────────────────
async function handlePhoneOtpVerify(req, res) {
  const { phone, token, firstName, lastName, country } = req.body || {};
  if (!phone || !token) return res.status(400).json({ error: 'Phone and OTP token are required.' });

  let clean = String(phone).replace(/\D/g, '');
  if (clean.startsWith('0'))  clean = '254' + clean.slice(1);
  if (!clean.startsWith('+')) clean = '+' + clean;

  const pub = getPublicClient();
  const { data, error } = await pub.auth.verifyOtp({
    phone: clean,
    token,
    type: 'sms',
  });

  if (error) {
    const msg = sbErr(error);
    console.error('[phone-otp-verify]', msg);
    if (msg?.includes('expired') || msg?.includes('invalid')) {
      return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' });
    }
    return res.status(400).json({ error: msg || 'OTP verification failed.' });
  }

  const userId = data.user?.id;
  if (!userId) return res.status(500).json({ error: 'Verification failed — no user returned.' });

  // Upsert profile
  const sb = getServiceClient();
  await upsertProfile(userId, {
    phone:         clean,
    first_name:    firstName || '',
    last_name:     lastName  || '',
    country:       country   || 'KE',
    demo_balance:  10000.00,
    live_balance:  0.00,
    kyc_status:    'unverified',
    referral_code: genCode(),
    petapips:      0,
    tier:          'bronze',
    created_at:    new Date().toISOString(),
  });

  const { data: profile } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();

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

// ── LOGOUT ────────────────────────────────────────────────────────────────────
async function handleLogout(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth:   { autoRefreshToken: false, persistSession: false },
      });
      await c.auth.signOut();
    } catch {}
  }
  return res.status(200).json({ success: true });
}

// ── ME ────────────────────────────────────────────────────────────────────────
async function handleMe(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const sb = getServiceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  return res.status(200).json({ user: profileToUser(user, profile) });
}

// ── RESET PASSWORD — sends email via Supabase ─────────────────────────────────
async function handleResetPassword(req, res) {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const pub     = getPublicClient();

  const { error } = await pub.auth.resetPasswordForEmail(
    email.toLowerCase().trim(),
    // redirectTo must be in Supabase Dashboard → Auth → URL Configuration → Redirect URLs
    { redirectTo: `${siteUrl}/?page=reset-password` }
  );

  if (error) {
    // IMPORTANT: normalise error — Supabase returns a plain object, not an Error instance
    const msg = sbErr(error);
    console.error('[reset-password] error:', msg);
    // Never reveal whether the email exists — always return success
    // (security best practice for password reset)
    if (msg?.includes('rate limit') || msg?.includes('too many')) {
      return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
    }
    // For any other error, still return success (don't leak email existence)
    console.error('[reset-password] suppressed error for security:', msg);
  }

  // Always return success so attackers can't enumerate registered emails
  return res.status(200).json({
    success: true,
    message: 'If that email is registered, a password reset link has been sent.',
  });
}

// ── UPDATE PASSWORD (after clicking reset link) ───────────────────────────────
async function handleUpdatePassword(req, res) {
  const { password } = req.body || {};
  const token        = req.headers.authorization?.replace('Bearer ', '');
  if (!token)                      return res.status(401).json({ error: 'Not authenticated.' });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const { createClient } = require('@supabase/supabase-js');
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });

  const { error } = await c.auth.updateUser({ password });
  if (error) {
    return res.status(400).json({ error: sbErr(error) || 'Password update failed.' });
  }
  return res.status(200).json({ success: true, message: 'Password updated successfully.' });
}

// ── RESEND VERIFICATION EMAIL ─────────────────────────────────────────────────
async function handleResendVerification(req, res) {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const pub     = getPublicClient();

  const { error } = await pub.auth.resend({
    type:  'signup',
    email: email.toLowerCase().trim(),
    options: { emailRedirectTo: `${siteUrl}/` },
  });

  if (error) {
    const msg = sbErr(error);
    console.error('[resend-verification] error:', msg);
    // Always return success — don't reveal whether email exists
  }

  return res.status(200).json({
    success: true,
    message: 'If that email is registered, a confirmation link has been sent. Check your inbox and spam folder.',
  });
}

// ── WELCOME EMAIL ─────────────────────────────────────────────────────────────
async function sendWelcomeEmail(toEmail, firstName, siteUrl) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) {
    console.warn('[email] SMTP env vars not set — skipping welcome email');
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
      Your Zenith FX account has been created. Check the <strong style="color:#fff">separate email from noreply@mail.app.supabase.io</strong>
      for your <strong style="color:#38bdf8">confirmation link</strong> — click it to activate your account and log in.
    </p>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1.4rem">
      <div style="font-size:.72rem;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.3rem">Demo Balance Ready</div>
      <div style="font-size:1.5rem;font-weight:800;color:#3fb950;font-family:monospace">$10,000.00</div>
      <div style="font-size:.75rem;color:#8b949e;margin-top:.2rem">Available immediately after email confirmation</div>
    </div>
    <p style="color:#8b949e;line-height:1.7;margin-bottom:1.4rem">
      After confirming, deposit via <strong style="color:#fff">M-Pesa</strong> from as little as <strong style="color:#fff">KES 100</strong> to start live trading.
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
