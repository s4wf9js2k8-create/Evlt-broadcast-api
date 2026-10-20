/**
 * EVLT Broadcast Push — Vercel serverless function.
 * Verifies a Firebase ID token and an explicitly allowlisted, verified
 * account before using server-side credentials to send notifications.
 *
 * Required Vercel environment variables:
 *   FCM_SERVICE_ACCOUNT_JSON   Firebase service-account JSON
 *   BROADCAST_ALLOWED_EMAILS  Comma-separated, verified admin email addresses
 *   ALLOWED_ORIGINS            Comma-separated exact dashboard origins
 */

const admin = require("firebase-admin");

const DATABASE_URL = "https://evlt-admin-default-rtdb.europe-west1.firebasedatabase.app";
let appInitialized = false;

function ensureAdminApp() {
  if (appInitialized) return;
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FCM service account is not configured");
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL,
  });
  appInitialized = true;
}

function csvSet(value) {
  return new Set(String(value || "").split(",").map((part) => part.trim()).filter(Boolean));
}

function jsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (e) { return null; }
  }
  return null;
}

module.exports = async (req, res) => {
  const allowedOrigins = csvSet(process.env.ALLOWED_ORIGINS);
  const origin = req.headers && req.headers.origin;

  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");

  if (!origin || !allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = jsonBody(req);
  if (!body || typeof body !== "object") return res.status(400).json({ error: "Invalid request body" });

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const message = typeof body.body === "string" ? body.body.trim() : "";
  if (!title || title.length > 120) return res.status(400).json({ error: "Title must be between 1 and 120 characters" });
  if (message.length > 2000) return res.status(400).json({ error: "Message must be 2000 characters or fewer" });

  const allowedEmails = new Set(Array.from(csvSet(process.env.BROADCAST_ALLOWED_EMAILS), (email) => email.toLowerCase()));
  if (allowedEmails.size === 0) return res.status(503).json({ error: "Broadcast access is not configured" });

  const authorization = req.headers && req.headers.authorization;
  const match = typeof authorization === "string" && authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: "Sign-in required" });

  try {
    ensureAdminApp();
    const decoded = await admin.auth().verifyIdToken(match[1], true);
    const email = typeof decoded.email === "string" ? decoded.email.toLowerCase() : "";
    const signInProvider = decoded.firebase && decoded.firebase.sign_in_provider;
    if (
      !decoded.email_verified ||
      !email ||
      signInProvider === "anonymous" ||
      !allowedEmails.has(email)
    ) {
      return res.status(403).json({ error: "This account is not allowed to send broadcasts" });
    }
  } catch (e) {
    if (e && (e.code === "auth/id-token-expired" || e.code === "auth/argument-error" || e.code === "auth/invalid-id-token" || e.code === "auth/id-token-revoked")) {
      return res.status(401).json({ error: "Sign-in expired; sign in again" });
    }
    console.error("Broadcast authorization or Firebase setup failed:", e);
    return res.status(503).json({ error: "Broadcast service is unavailable" });
  }

  try {
    const tokensSnapshot = await admin.database().ref("push_tokens").once("value");
    const tokensObj = tokensSnapshot.val() || {};
    const entries = Object.entries(tokensObj);
    const tokens = entries.map(([, value]) => value && value.token).filter(Boolean);

    if (tokens.length === 0) {
      return res.status(200).json({ sent: 0, failed: 0, removedInvalidTokens: 0, note: "No registered tokens found." });
    }

    let sent = 0;
    let failed = 0;
    const dbKeysToRemove = [];
    const BATCH_SIZE = 500;

    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batchTokens = tokens.slice(i, i + BATCH_SIZE);
      const batchEntries = entries.slice(i, i + BATCH_SIZE);
      let response;
      try {
        response = await admin.messaging().sendEachForMulticast({
          tokens: batchTokens,
          notification: { title, body: message },
          webpush: { notification: { icon: "/apple-touch-icon.png" } },
        });
      } catch (e) {
        console.error("FCM batch send failed:", e);
        failed += batchTokens.length;
        continue;
      }

      response.responses.forEach((result, index) => {
        if (result.success) {
          sent++;
          return;
        }
        failed++;
        const code = result.error && result.error.code;
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token" ||
          code === "messaging/invalid-argument"
        ) {
          dbKeysToRemove.push(batchEntries[index][0]);
        }
      });
    }

    if (dbKeysToRemove.length) {
      const updates = {};
      dbKeysToRemove.forEach((key) => { updates[key] = null; });
      try {
        await admin.database().ref("push_tokens").update(updates);
      } catch (e) {
        console.warn("Could not remove invalid FCM tokens:", e);
      }
    }

    return res.status(200).json({ sent, failed, removedInvalidTokens: dbKeysToRemove.length });
  } catch (e) {
    console.error("Broadcast delivery failed:", e);
    return res.status(503).json({ error: "Broadcast delivery failed" });
  }
};
