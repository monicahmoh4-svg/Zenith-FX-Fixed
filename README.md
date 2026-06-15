# Zenith FX — Production Deployment Guide

## Files in This Project

```
zenithfx/
├── index.html              ← Full SPA frontend
├── api/
│   ├── mpesa.js            ← Real Lipana.dev STK push + callback + withdraw
│   ├── auth.js             ← Register, login, Google OAuth, password reset
│   ├── email.js            ← Transactional emails via SMTP
│   ├── kyc.js              ← KYC upload to Supabase Storage + admin review
│   └── trade.js            ← Place/settle trades, history, balance sync
├── supabase-schema.sql     ← Run once in Supabase SQL editor
├── vercel.json             ← Vercel routing config (do not edit)
├── package.json            ← Node dependencies
├── .env.example            ← All required environment variables
└── README.md               ← This file
```

---

## Step 1 — Supabase Setup (5 minutes)

1. Go to **https://supabase.com** → New Project (free tier is fine)
2. Choose a region close to Kenya (e.g. `eu-central-1`)
3. Once created, go to **SQL Editor → New Query**
4. Paste the entire contents of `supabase-schema.sql` and click **Run**
5. Go to **Project Settings → API** and copy:
   - `Project URL` → this is your `SUPABASE_URL`
   - `anon public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

### Enable Google OAuth in Supabase
1. Supabase Dashboard → **Authentication → Providers → Google** → Enable
2. Paste your Google Client ID and Secret (from Step 3 below)
3. Copy the **Callback URL** shown (e.g. `https://xxxx.supabase.co/auth/v1/callback`)

---

## Step 2 — Lipana.dev Setup (2 minutes)

1. Go to **https://lipana.dev** → Sign up / Log in
2. Connect your Safaricom Daraja credentials (they walk you through it)
3. Dashboard → **API Keys** → copy your `Secret Key` (starts with `lip_sk_live_`)
4. Dashboard → **Webhooks** → Add webhook:
   - URL: `https://YOUR-VERCEL-URL.vercel.app/api/mpesa?action=callback`
   - Events: `payment.success`, `payment.failed`
   - Copy the **Webhook Secret** shown

---

## Step 3 — Google OAuth Setup (3 minutes)

1. Go to **https://console.cloud.google.com**
2. Create a new project (or use existing)
3. APIs & Services → **Credentials** → Create Credentials → OAuth 2.0 Client ID
4. Application type: **Web application**
5. Authorized redirect URIs → Add:
   ```
   https://YOUR-SUPABASE-PROJECT.supabase.co/auth/v1/callback
   ```
6. Copy **Client ID** and **Client Secret**

---

## Step 4 — Gmail App Password for Email (2 minutes)

1. Go to your Google Account → **Security → 2-Step Verification** (must be ON)
2. Search for **App Passwords** → Generate one for "Mail"
3. Copy the 16-character password (e.g. `abcd efgh ijkl mnop`)

---

## Step 5 — Deploy to GitHub + Vercel

### Push to GitHub
```bash
git init
git add .
git commit -m "Zenith FX v2 — production"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/zenithfx.git
git push -u origin main
```

### Deploy on Vercel
1. Go to **https://vercel.com** → New Project
2. Import your `zenithfx` GitHub repo
3. Framework: **Other** (leave default)
4. Click **Deploy** — first deploy will work but M-Pesa won't until env vars are set

---

## Step 6 — Add Environment Variables in Vercel

Vercel Dashboard → Your Project → **Settings → Environment Variables**

Add each of these:

| Variable | Value | Where to get it |
|----------|-------|-----------------|
| `NEXT_PUBLIC_SITE_URL` | `https://zenithfx.vercel.app` | Your Vercel URL |
| `SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase → Settings → API |
| `SUPABASE_ANON_KEY` | `eyJ...` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Supabase → Settings → API |
| `LIPANA_SECRET_KEY` | `lip_sk_live_XXXX` | Lipana Dashboard → API Keys |
| `LIPANA_WEBHOOK_SECRET` | `whsec_XXXX` | Lipana Dashboard → Webhooks |
| `SMTP_HOST` | `smtp.gmail.com` | Fixed |
| `SMTP_PORT` | `587` | Fixed |
| `SMTP_USER` | `mwebidouglas08@gmail.com` | Your Gmail |
| `SMTP_PASS` | `abcd efgh ijkl mnop` | Gmail App Password |
| `SMTP_FROM` | `Zenith FX <noreply@zenithfx.io>` | Your sender name |
| `ADMIN_EMAIL` | `mwebidouglas08@gmail.com` | Your admin email |
| `USD_KES_RATE` | `130` | Adjust as needed |

After adding all variables → **Deployments → Redeploy** (top right → Redeploy)

---

## Step 7 — Update Lipana Webhook URL

After Vercel gives you a URL (e.g. `https://zenithfx.vercel.app`):
1. Go to Lipana Dashboard → Webhooks
2. Update the URL to: `https://zenithfx.vercel.app/api/mpesa?action=callback`
3. Save

---

## How Real M-Pesa Flow Works

```
User enters phone + amount
        ↓
Frontend → POST /api/mpesa?action=stkpush
        ↓
Server → Lipana API (push-stk) → Safaricom sends PIN prompt to phone
        ↓
User enters M-Pesa PIN on phone
        ↓
Safaricom → Lipana → POST /api/mpesa?action=callback (webhook)
        ↓
Server verifies Lipana signature, updates transaction status in Supabase
        ↓
Frontend polls /api/mpesa?action=status every 3 seconds
        ↓
Status = "success" → balance credited, email sent, UI updated
```

---

## Custom Domain (Optional)

1. Vercel → Settings → Domains → Add `zenithfx.io`
2. At your domain registrar, add:
   - `A` record: `76.76.21.21`
   - `CNAME www`: `cname.vercel-dns.com`
3. SSL auto-provisioned by Vercel (takes ~2 minutes)
4. Update `NEXT_PUBLIC_SITE_URL` to `https://zenithfx.io` and redeploy
5. Update Lipana webhook URL to `https://zenithfx.io/api/mpesa?action=callback`
6. Update Supabase Google OAuth redirect to `https://zenithfx.io`
