# Soundverse AI Enterprise API — 5-Minute Quickstart

Generate your first AI song in under 5 minutes.

---

## 1. Start the API Server

If not already running:

```bash
npm start
```

The server runs at `http://localhost:3000`.

---

## 2. Sign Up & Verify Account

### Create Account:
```bash
curl -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "developer@example.com",
    "password": "SuperSecretPass123!"
  }'
```

*Response:*
```json
{
  "message": "Account created. Please verify your email using the link sent/logged.",
  "verification_link": "http://localhost:3000/auth/verify?token=..."
}
```

### Verify Email:
Open the `verification_link` printed in your server terminal or execute:
```bash
curl http://localhost:3000/auth/verify?token=<YOUR_TOKEN>
```

---

## 3. Log In & Create an API Key

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "developer@example.com",
    "password": "SuperSecretPass123!"
  }'
```
Copy the JWT `token` from the response.

### Create a Test or Live Key:
```bash
curl -X POST http://localhost:3000/dashboard/keys \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My First Key",
    "mode": "test"
  }'
```

*Response (Copy this secret! It is only shown once):*
```json
{
  "key": {
    "id": "...",
    "key_prefix": "sk_test_4f82...",
    "mode": "test",
    "scopes": ["generations:write", "generations:read"]
  },
  "secret": "sk_test_4f82a9b3104e..."
}
```

---

## 4. Generate Your First Song

```bash
curl -X POST http://localhost:3000/v1/generations \
  -H "Authorization: Bearer sk_test_..." \
  -H "Idempotency-Key: my-first-req-001" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "uplifting acoustic pop for a travel vlog, warm guitars",
    "duration_sec": 30,
    "license": "royalty_free",
    "instrumental": true,
    "metadata": {
      "customer_ref": "vid_8812"
    }
  }'
```

*Response (HTTP 202 Accepted):*
```json
{
  "id": "gen_8zQ19pLa",
  "status": "queued",
  "license": "royalty_free",
  "credits_charged": 0,
  "output": null,
  "created_at": "2026-10-09T08:30:00Z"
}
```

---

## 5. Check Generation Status & Listen to Result

Poll the status:

```bash
curl http://localhost:3000/v1/generations/gen_8zQ19pLa \
  -H "Authorization: Bearer sk_test_..."
```

When done, the response contains your signed expiring audio URL:
```json
{
  "id": "gen_8zQ19pLa",
  "status": "succeeded",
  "output": {
    "audio_url": "http://localhost:3000/v1/audio/gen_8zQ19pLa.mp3?expires=...&signature=...",
    "duration_sec": 30,
    "format": "mp3"
  }
}
```

Open the `audio_url` in your browser or curl it to download the MP3!

