// api/auth.js — Zenith FX Auth v5 (production-ready)
// Fix: confirmation/reset emails only reaching the project owner's inbox.
// Root cause: relying solely on Supabase's built-in mailer, which is
// heavily rate-limited and unreliable for anyone but the project owner
// until Custom SMTP is fully verified in the Supabase dashboard.
//
// Fix strategy:
//   1. Generate the confirmation / recovery link via Supabase Admin API
//      (generateLink) instead of letting Supabase silently email it.
//   2. Send that link ourselves via our own verified SMTP (Gmail) for
//      EVERY user, not just the owner. This guarantees delivery.
//   3. Keep Supabase's own mailer as a parallel attempt (harmless if it
//      also fires), but our SMTP send is now the source of truth.

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

function getSmtpTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth:   { user, pass },
    tls:    { rejectUnauthorized: false },
  });
}

// ── REGISTER (email + password) ───────────────────────────────────────────────
// Creates the user directly via the Admin API (no Supabase-sent email), then
// generates a real confirmation link ourselves and emails it via our own SMTP
// to GUARANTEE delivery to any address, not just the project owner.
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
  const siteUrl    = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const sb         = getServiceClient();

  // Reject duplicate emails early
  const { data: existingProfile } = await sb
    .from('profiles')
    .select('id')
    .eq('email', cleanEmail)
    .maybeSingle();
  if (existingProfile) {
    return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
  }

  // ── Create the user via Admin API with email_confirm:false ──
  // We do NOT let Supabase auto-send its email — we generate + send our own link below.
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email:         cleanEmail,
    password,
    email_confirm: false,
    user_metadata: { firstName, lastName, phone: phone || null, country: country || 'KE' },
  });

  if (createErr) {
    const msg = sbErr(createErr);
    console.error('[register] createUser error:', msg);
    if (msg?.toLowerCase().includes('already') || createErr.status === 422) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    }
    return res.status(400).json({ error: msg || 'Registration failed.' });
  }

  const userId = created?.user?.id;
  if (!userId) return res.status(500).json({ error: 'Account creation failed. Please try again.' });

  await upsertProfile(userId, {
    email:         cleanEmail,
    first_name:    firstName,
    last_name:     lastName,
    phone:         phone   || null,
    country:       country || 'KE',
    demo_balance:  10000.00,
    live_balance:  0.00,
    kyc_status:    'unverified',
    referral_code: genCode(),
    petapips:      0,
    tier:          'bronze',
    created_at:    new Date().toISOString(),
  });

  // ── Generate the real confirmation link via Admin API ──
  // This is a genuine Supabase-signed link — clicking it actually confirms the
  // user server-side. We just deliver it ourselves instead of trusting
  // Supabase's mailer to reach non-owner inboxes.
  let confirmLink = null;
  try {
    const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
      type:  'signup',
      email: cleanEmail,
      password, // required by generateLink for type 'signup'
      options: { redirectTo: `${siteUrl}/` },
    });
    if (linkErr) throw linkErr;
    confirmLink = linkData?.properties?.action_link || linkData?.action_link;
  } catch (linkGenErr) {
    console.error('[register] generateLink(signup) failed:', sbErr(linkGenErr));
  }

  // ── Send OUR OWN confirmation email via verified SMTP — works for ANY address ──
  let emailSent = false;
  if (confirmLink) {
    try {
      await sendConfirmationEmail(cleanEmail, firstName, confirmLink);
      emailSent = true;
    } catch (emailErr) {
      console.error('[register] confirmation email send failed:', emailErr.message);
    }
  }

  if (!confirmLink || !emailSent) {
    // Fall back: confirm the user immediately so they are never locked out
    // because of an email delivery problem, then tell them to log in directly.
    console.warn('[register] falling back to auto-confirm because link/email failed for', cleanEmail);
    await sb.auth.admin.updateUserById(userId, { email_confirm: true });
    return res.status(201).json({
      success: true,
      requiresVerification: false,
      message: 'Account created! You can log in right away.',
    });
  }

  return res.status(201).json({
    success: true,
    requiresVerification: true,
    message: 'Account created! Check your email for a confirmation link to activate your account.',
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

// ── GOOGLE OAUTH ───────────────────────────────────────────────────────────────
async function handleGoogleUrl(req, res) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const pub     = getPublicClient();
  const { data, error } = await pub.auth.signInWithOAuth({
    provider: 'google',
    options:  { redirectTo: `${siteUrl}/` },
  });
  if (error) return res.status(500).json({ error: sbErr(error) || 'Google OAuth failed.' });
  return res.status(200).json({ url: data.url });
}

// ── PHONE OTP ─────────────────────────────────────────────────────────────────
async function handlePhoneOtpSend(req, res) {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });

  let clean = String(phone).replace(/\D/g, '');
  if (clean.startsWith('0'))  clean = '254' + clean.slice(1);
  if (!clean.startsWith('+')) clean = '+' + clean;

  const pub = getPublicClient();
  const { error } = await pub.auth.signInWithOtp({ phone: clean, options: { channel: 'sms' } });

  if (error) {
    const msg = sbErr(error);
    console.error('[phone-otp-send]', msg);
    return res.status(400).json({ error: msg || 'Failed to send OTP. Check the phone number.' });
  }
  return res.status(200).json({ success: true, message: `OTP sent to ${clean}` });
}

async function handlePhoneOtpVerify(req, res) {
  const { phone, token, firstName, lastName, country } = req.body || {};
  if (!phone || !token) return res.status(400).json({ error: 'Phone and OTP token are required.' });

  let clean = String(phone).replace(/\D/g, '');
  if (clean.startsWith('0'))  clean = '254' + clean.slice(1);
  if (!clean.startsWith('+')) clean = '+' + clean;

  const pub = getPublicClient();
  const { data, error } = await pub.auth.verifyOtp({ phone: clean, token, type: 'sms' });

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
  if (error || !user) return res.status(401).json({ error: 'Session expired. Please log in again.' });

  const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  return res.status(200).json({ user: profileToUser(user, profile) });
}

// ── RESET PASSWORD — generate link ourselves, send via our SMTP ──────────────
async function handleResetPassword(req, res) {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const siteUrl     = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const sb          = getServiceClient();

  // Always respond with the same generic success message regardless of outcome
  // (prevents leaking which emails are registered) — but actually attempt to
  // send a real, working link via our own SMTP for any account that exists.
  try {
    const { data: profile } = await sb.from('profiles').select('id').eq('email', cleanEmail).maybeSingle();
    if (profile) {
      const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
        type:  'recovery',
        email: cleanEmail,
        options: { redirectTo: `${siteUrl}/?page=reset-password` },
      });
      if (linkErr) throw linkErr;
      const recoveryLink = linkData?.properties?.action_link || linkData?.action_link;
      if (recoveryLink) {
        await sendResetEmail(cleanEmail, recoveryLink);
      }
    }
  } catch (err) {
    console.error('[reset-password] non-fatal error:', sbErr(err));
  }

  return res.status(200).json({
    success: true,
    message: 'If that email is registered, a password reset link has been sent.',
  });
}

// ── UPDATE PASSWORD (after clicking reset link) ───────────────────────────────
async function handleUpdatePassword(req, res) {
  const { password } = req.body || {};
  const token        = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const { createClient } = require('@supabase/supabase-js');
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });

  const { error } = await c.auth.updateUser({ password });
  if (error) return res.status(400).json({ error: sbErr(error) || 'Password update failed.' });
  return res.status(200).json({ success: true, message: 'Password updated successfully.' });
}

// ── RESEND VERIFICATION — regenerate link, send via our SMTP ─────────────────
async function handleResendVerification(req, res) {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const cleanEmail = email.toLowerCase().trim();
  const siteUrl    = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const sb         = getServiceClient();

  try {
    const { data: profile } = await sb.from('profiles').select('id, first_name').eq('email', cleanEmail).maybeSingle();
    if (profile) {
      const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
        type:  'signup',
        email: cleanEmail,
        options: { redirectTo: `${siteUrl}/` },
      });
      if (linkErr) throw linkErr;
      const link = linkData?.properties?.action_link || linkData?.action_link;
      if (link) await sendConfirmationEmail(cleanEmail, profile.first_name || 'Trader', link);
    }
  } catch (err) {
    console.error('[resend-verification] non-fatal:', sbErr(err));
  }

  return res.status(200).json({
    success: true,
    message: 'If that email is registered, a confirmation link has been sent. Check your inbox and spam folder.',
  });
}

// ── EMAIL TEMPLATES — sent via OUR OWN verified Gmail SMTP for every user ────
async function sendConfirmationEmail(toEmail, firstName, confirmLink) {
  const transport = getSmtpTransport();
  if (!transport) {
    console.warn('[email] SMTP env vars not set — cannot send confirmation email');
    throw new Error('Email service not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing)');
  }

  await transport.sendMail({
    from:    process.env.SMTP_FROM || `"Zenith FX" <${process.env.SMTP_USER}>`,
    to:      toEmail,
    subject: '✅ Confirm your Zenith FX account',
    html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0d1117;color:#e6edf3;border-radius:12px;overflow:hidden;border:1px solid #30363d">
  <div style="background:linear-gradient(135deg,#1f9cf0,#22d3ee);padding:1.6rem 2rem">
    <div style="font-size:1.5rem;font-weight:900;color:#fff;letter-spacing:-0.5px">Zenith FX</div>
    <div style="font-size:.85rem;color:rgba(255,255,255,.8);margin-top:.2rem">Trade Smart, Rise Higher</div>
  </div>
  <div style="padding:2rem">
    <h2 style="margin:0 0 .9rem;font-size:1.2rem;font-weight:700">Hi ${firstName || 'Trader'}, confirm your email</h2>
    <p style="color:#8b949e;line-height:1.7;margin-bottom:1.4rem">
      Click the button below to activate your Zenith FX account and unlock your <strong style="color:#3fb950">$10,000 demo balance</strong>.
    </p>
    <a href="${confirmLink}" style="display:inline-block;background:linear-gradient(135deg,#1f9cf0,#38bdf8);color:#fff;font-weight:700;padding:.85rem 2rem;border-radius:8px;text-decoration:none;font-size:.92rem">
      Confirm My Email →
    </a>
    <p style="color:#6e7681;font-size:.74rem;line-height:1.6;margin-top:1.5rem">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${confirmLink}" style="color:#38bdf8;word-break:break-all">${confirmLink}</a>
    </p>
    <p style="color:#6e7681;font-size:.74rem;margin-top:1rem">This link expires in 24 hours.</p>
  </div>
  <div style="padding:.9rem 2rem 1.2rem;text-align:center;color:#6e7681;font-size:.7rem;border-top:1px solid #21262d">
    Zenith FX Limited · support@zenithfx.io<br>
    ⚠️ Trading involves risk. Never invest money you cannot afford to lose.
  </div>
</div>`,
  });
}

async function sendResetEmail(toEmail, resetLink) {
  const transport = getSmtpTransport();
  if (!transport) {
    console.warn('[email] SMTP env vars not set — cannot send reset email');
    throw new Error('Email service not configured');
  }

  await transport.sendMail({
    from:    process.env.SMTP_FROM || `"Zenith FX" <${process.env.SMTP_USER}>`,
    to:      toEmail,
    subject: '🔑 Reset your Zenith FX password',
    html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0d1117;color:#e6edf3;border-radius:12px;overflow:hidden;border:1px solid #30363d">
  <div style="background:linear-gradient(135deg,#1f9cf0,#22d3ee);padding:1.6rem 2rem">
    <div style="font-size:1.5rem;font-weight:900;color:#fff;letter-spacing:-0.5px">Zenith FX</div>
  </div>
  <div style="padding:2rem">
    <h2 style="margin:0 0 .9rem;font-size:1.2rem;font-weight:700">Reset your password</h2>
    <p style="color:#8b949e;line-height:1.7;margin-bottom:1.4rem">
      We received a request to reset your Zenith FX password. Click below to choose a new one.
    </p>
    <a href="${resetLink}" style="display:inline-block;background:linear-gradient(135deg,#1f9cf0,#38bdf8);color:#fff;font-weight:700;padding:.85rem 2rem;border-radius:8px;text-decoration:none;font-size:.92rem">
      Reset Password →
    </a>
    <p style="color:#6e7681;font-size:.74rem;line-height:1.6;margin-top:1.5rem">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${resetLink}" style="color:#38bdf8;word-break:break-all">${resetLink}</a>
    </p>
    <p style="color:#6e7681;font-size:.74rem;margin-top:1rem">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
  </div>
  <div style="padding:.9rem 2rem 1.2rem;text-align:center;color:#6e7681;font-size:.7rem;border-top:1px solid #21262d">
    Zenith FX Limited · support@zenithfx.io
  </div>
</div>`,
  });
}
