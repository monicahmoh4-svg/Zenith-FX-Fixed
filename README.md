# Zenith FX — Trading Platform

> Africa's leading binary options & multi-asset trading platform. Built to look and feel exactly like TagOption.ke with the Zenith FX brand.

---

## 🚀 Deploy to Vercel in 5 Minutes

### Step 1 — Push to GitHub

```bash
# 1. Create a new repo on github.com (e.g. zenithfx)
# 2. Then in your terminal:

git init
git add .
git commit -m "Initial commit — Zenith FX trading platform"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/zenithfx.git
git push -u origin main
```

### Step 2 — Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) → **New Project**
2. Import your `zenithfx` GitHub repo
3. Leave all settings as default — Vercel auto-detects the config
4. Click **Deploy**
5. Your site is live at `https://zenithfx.vercel.app`

### Step 3 — Add Environment Variables (Required for M-Pesa)

In your Vercel project → **Settings → Environment Variables**, add:

| Key | Value | Description |
|-----|-------|-------------|
| `LIPANA_API_KEY` | `your_key_here` | From lipana.dev dashboard |
| `LIPANA_BASE_URL` | `https://api.lipana.dev` | Lipana API base URL |
| `SITE_URL` | `https://yourdomain.com` | Your production URL |
| `USD_KES_RATE` | `130` | USD to KES exchange rate |

> ⚡ After adding env vars, go to **Deployments → Redeploy** to apply them.

---

## 📁 Project Structure

```
zenithfx/
├── index.html          # Full single-page app (home + auth + dashboard)
├── api/
│   └── mpesa.js        # Vercel serverless function — Lipana.dev STK push
├── vercel.json         # Vercel routing config
├── package.json        # Node.js deps for serverless functions
└── README.md           # This file
```

---

## 💳 M-Pesa Integration (Lipana.dev)

### How it works

1. User enters their Safaricom number and amount
2. Frontend calls `/api/mpesa?action=stkpush`
3. Server calls **Lipana.dev** API to send an STK Push
4. User receives a PIN prompt on their phone
5. Frontend polls `/api/mpesa?action=status` every 3 seconds
6. On success, balance is credited instantly

### Getting your Lipana.dev API Key

1. Go to [lipana.dev](https://lipana.dev)
2. Create a free account
3. Connect your Safaricom Daraja credentials
4. Copy your API key
5. Paste it into Vercel env variables as `LIPANA_API_KEY`

### Testing Without API Key

The platform works in **simulation mode** without an API key — deposits are credited automatically after 4 seconds. Perfect for demos.

---

## 🎯 Features

### Public Pages
- ✅ Hero with live-animated badge ("Over 1 million traders")
- ✅ Live price ticker (BTC, ETH, EUR/USD, Gold, V10, etc.)
- ✅ Markets grid (Synthetics, Digits, Forex, Crypto, Commodities, Indices)
- ✅ Features section
- ✅ How It Works (3 steps)
- ✅ Testimonials from African traders
- ✅ Affiliate program section
- ✅ Risk warning + Footer

### Auth System
- ✅ Login with email + password validation
- ✅ Register with full form validation
- ✅ Password strength meter
- ✅ Show/hide password toggle
- ✅ Social login buttons (Google, Phone)
- ✅ Remember me + Forgot password

### Trader Dashboard
- ✅ **PetaPips** branding, *Unajua Kwa Mbae*, `mwebidouglas08@gmail.com`
- ✅ Demo / Live account toggle
- ✅ Demo balance starts at **$10,000** with reset button
- ✅ Sidebar navigation with all 9 sections
- ✅ Mobile-responsive collapsible sidebar

### Trading Engine
- ✅ Real-time animated chart (Line / Candles / Area)
- ✅ 35+ assets across 5 categories with live price simulation
- ✅ Asset picker with search
- ✅ Binary Options + Multiplier modes
- ✅ Contract types: Rise/Fall, Even/Odd, Match/Differ, Over/Under
- ✅ Digit distribution grid (0–9)
- ✅ Stake input with quick-add buttons (+1, +5, +10, +25, +50, +100)
- ✅ Duration selector (ticks / seconds / minutes / hours)
- ✅ Live payout calculator
- ✅ Open positions with live tick countdown
- ✅ Auto-settle with win/loss toast notifications
- ✅ Balance deducted on trade, credited on win

### Deposit (M-Pesa via Lipana.dev)
- ✅ M-Pesa STK Push (Lipana.dev API)
- ✅ Bank transfer with reference
- ✅ Crypto deposit address
- ✅ Card payment form
- ✅ Amount presets (500, 1K, 2.5K, 5K, 10K)
- ✅ Waiting modal with spinner

### Withdrawals
- ✅ M-Pesa B2C via Lipana.dev
- ✅ Balance check + min amount validation
- ✅ Demo account guard
- ✅ Amount presets

### Other Sections
- ✅ KYC with 5-step progress tracker + document upload
- ✅ Copy Trading — 4 trader cards with stats
- ✅ Affiliate — referral link + copy button + stats
- ✅ Loyalty — PetaPips gold tier with progress bar
- ✅ Profile — edit info, change password, 2FA toggle

---

## 🎨 Design

Exact TagOption.ke color palette:

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#0d1117` | Page background |
| `--bg2` | `#161b22` | Cards, sidebar |
| `--bg3` | `#1c2333` | Input fields |
| `--accent` | `#1f9cf0` | Primary blue (TagOption exact) |
| `--accent2` | `#38bdf8` | Cyan highlights |
| `--green` | `#3fb950` | Rise / Win |
| `--red` | `#f85149` | Fall / Loss |
| `--gold` | `#d29922` | PetaPips / Gold tier |
| `--text` | `#e6edf3` | Primary text |
| `--text2` | `#8b949e` | Secondary text |

Font: **Inter** (same as TagOption) + **JetBrains Mono** for prices

---

## 🔧 Custom Domain on Vercel

1. Vercel project → **Settings → Domains**
2. Add `zenithfx.io` (or your domain)
3. Update DNS at your registrar:
   - `A` record → `76.76.21.21`
   - `CNAME www` → `cname.vercel-dns.com`
4. SSL auto-configured by Vercel

---

## 📞 Support

- Email: support@zenithfx.io
- Lipana.dev docs: https://lipana.dev/docs
- Vercel docs: https://vercel.com/docs
