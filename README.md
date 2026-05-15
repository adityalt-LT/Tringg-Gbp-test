# Tringg — GBP OAuth Test Server

Deploy to Railway → share URL → anyone with a GBP-linked Google account can test the import.

---

## Deploy to Railway (free, public URL)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/tringg-gbp-test.git
git push -u origin main
```

### 2. Deploy on Railway
1. Go to railway.app → sign in with GitHub
2. New Project → Deploy from GitHub repo → select tringg-gbp-test
3. Settings → Networking → Generate Domain
4. Copy your public URL: https://tringg-gbp-test-production.up.railway.app

### 3. Add environment variables on Railway
Variables tab → add these three:

| Variable | Value |
|---|---|
| GOOGLE_CLIENT_ID | Your Client ID from Google Console |
| GOOGLE_CLIENT_SECRET | Your Client Secret from Google Console |
| REDIRECT_URI | https://YOUR-RAILWAY-URL.up.railway.app/auth/google/callback |

### 4. Update Google Console redirect URI
APIs & Services → Credentials → your OAuth Client → Authorised redirect URIs → Add:
```
https://YOUR-RAILWAY-URL.up.railway.app/auth/google/callback
```

### 5. Add test users
APIs & Services → OAuth consent screen → Test users → Add the Gmail of each tester.
Required until Google verifies the app.

### 6. Share the URL
Send https://YOUR-RAILWAY-URL.up.railway.app to anyone who needs to test.

---

## Local development
```bash
npm install
node server.js
# Open http://localhost:3000
```

---

## Common errors

| Error | Fix |
|---|---|
| redirect_uri_mismatch | REDIRECT_URI in Railway must exactly match Google Console |
| Access blocked: app not verified | Add tester Gmail to OAuth consent screen Test Users |
| 403 Permission denied | Enable both My Business APIs in Google Cloud Console |
| No GBP found | Signed-in account doesn't manage any GBP listing |
