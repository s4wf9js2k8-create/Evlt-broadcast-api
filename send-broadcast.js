/**
 * EVLT Broadcast Push — Vercel serverless function
 * -----------------------------------------------------------------
 * Sends a Firebase Cloud Messaging push to a list of device tokens.
 * The Firebase service-account credential lives only in Vercel
 * environment variables — never in code, never in the client.
 *
 * REQUIRED ENVIRONMENT VARIABLES (Vercel dashboard -> your project
 * -> Settings -> Environment Variables -> Add, for "Production"):
 *
 *   FCM_SERVICE_ACCOUNT_JSON  -> the full contents of your Firebase
 *                                service-account JSON key, pasted as
 *                                one value
 *   BROADCAST_SECRET          -> any long random string you make up.
 *                                Must match BROADCAST_SECRET_CLIENT
 *                                in index.html
 *
 * Deployed URL will look like:
 *   https://<your-project>.vercel.app/api/send-broadcast
 *
 * Request format expected from the app:
 *   POST /api/send-broadcast
 *   { "secret": "...", "title": "...", "body": "...", "tokens": ["...", ...] }
 *
 * Response:
 *   { "sent": <n>, "failed": <n>, "invalidTokens": ["...", ...] }
 */

const jwt = require("jsonwebtoken");

const PROJECT_ID = "evlt-admin";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { secret, title, body, tokens } = req.body || {};

  if (!process.env.BROADCAST_SECRET || secret !== process.env.BROADCAST_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!title || !Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({ error: "Missing title or tokens" });
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    return res.status(500).json({ error: "Server misconfigured: bad service account env var" });
  }

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(serviceAccount);
  } catch (e) {
    return res.status(500).json({ error: "Failed to authenticate with Google: " + e.message });
  }

  let sent = 0;
  let failed = 0;
  const invalidTokens = [];

  const BATCH_SIZE = 25;
  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((t) => sendOne(accessToken, t, title, body)));
    results.forEach((r, idx) => {
      if (r.ok) {
        sent++;
      } else {
        failed++;
        if (r.invalid) invalidTokens.push(batch[idx]);
      }
    });
  }

  return res.status(200).json({ sent, failed, invalidTokens });
};

async function sendOne(accessToken, token, title, body) {
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body: body || "" },
        webpush: { notification: { icon: "/apple-touch-icon.png" } },
      },
    }),
  });

  if (resp.ok) return { ok: true };

  const errText = await resp.text().catch(() => "");
  const invalid =
    errText.includes("UNREGISTERED") ||
    errText.includes("NOT_FOUND") ||
    errText.includes("INVALID_ARGUMENT");
  return { ok: false, invalid };
}

async function getGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);

  const assertion = jwt.sign(
    {
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: serviceAccount.token_uri,
      iat: now,
      exp: now + 3600,
    },
    serviceAccount.private_key,
    { algorithm: "RS256" }
  );

  const tokenRes = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => "");
    throw new Error("Token exchange failed: " + errText);
  }

  const data = await tokenRes.json();
  return data.access_token;
}
