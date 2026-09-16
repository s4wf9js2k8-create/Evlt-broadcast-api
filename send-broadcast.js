/**
 * EVLT Broadcast Push — Vercel serverless function (v2)
 * -----------------------------------------------------------------
 * Sends a Firebase Cloud Messaging push to every registered device.
 * Unlike the first version, THIS function fetches the token list
 * itself (server-side, using admin credentials that bypass your
 * database security rules) rather than trusting the browser to read
 * and forward it — the browser correctly can't read the full
 * push_tokens list, which is why the previous version never fired.
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
 * After changing either variable, redeploy (Deployments tab -> "..."
 * on latest -> Redeploy) so the function picks up the new value.
 *
 * Request format expected from the app:
 *   POST /api/send-broadcast
 *   { "secret": "...", "title": "...", "body": "..." }
 *   (no "tokens" needed anymore — the server looks them up itself)
 *
 * Response:
 *   { "sent": <n>, "failed": <n>, "removedInvalidTokens": <n> }
 */

const admin = require("firebase-admin");

const DATABASE_URL = "https://evlt-admin-default-rtdb.europe-west1.firebasedatabase.app";

let appInitialized = false;

function ensureAdminApp() {
  if (appInitialized) return;
  const serviceAccount = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL,
  });
  appInitialized = true;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { secret, title, body } = req.body || {};

  if (!process.env.BROADCAST_SECRET || secret !== process.env.BROADCAST_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!title) {
    return res.status(400).json({ error: "Missing title" });
  }

  try {
    ensureAdminApp();
  } catch (e) {
    return res.status(500).json({ error: "Server misconfigured: bad service account env var" });
  }

  let tokensSnapshot;
  try {
    tokensSnapshot = await admin.database().ref("push_tokens").once("value");
  } catch (e) {
    return res.status(500).json({ error: "Failed to read push_tokens from database: " + e.message });
  }

  const tokensObj = tokensSnapshot.val() || {};
  const entries = Object.entries(tokensObj); // [ [dbKey, {token, user, ...}], ... ]
  const tokens = entries.map(([, v]) => v && v.token).filter(Boolean);

  if (tokens.length === 0) {
    return res.status(200).json({ sent: 0, failed: 0, removedInvalidTokens: 0, note: "No registered tokens found." });
  }

  let sent = 0;
  let failed = 0;
  const dbKeysToRemove = [];

  // sendEachForMulticast handles up to 500 tokens per call.
  const BATCH_SIZE = 500;
  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batchTokens = tokens.slice(i, i + BATCH_SIZE);
    const batchEntries = entries.slice(i, i + BATCH_SIZE);

    let response;
    try {
      response = await admin.messaging().sendEachForMulticast({
        tokens: batchTokens,
        notification: { title, body: body || "" },
        webpush: { notification: { icon: "/apple-touch-icon.png" } },
      });
    } catch (e) {
      failed += batchTokens.length;
      continue;
    }

    response.responses.forEach((r, idx) => {
      if (r.success) {
        sent++;
      } else {
        failed++;
        const code = r.error && r.error.code;
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token" ||
          code === "messaging/invalid-argument"
        ) {
          dbKeysToRemove.push(batchEntries[idx][0]);
        }
      }
    });
  }

  if (dbKeysToRemove.length) {
    const updates = {};
    dbKeysToRemove.forEach((key) => (updates[key] = null));
    try {
      await admin.database().ref("push_tokens").update(updates);
    } catch (e) {
      // Non-fatal: stale tokens will just be retried (and fail again) next time.
    }
  }

  return res.status(200).json({ sent, failed, removedInvalidTokens: dbKeysToRemove.length });
};
