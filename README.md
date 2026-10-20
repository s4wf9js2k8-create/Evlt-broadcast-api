# EVLT Broadcast API

The dashboard calls this Vercel function to send Firebase Cloud Messaging alerts to registered devices.

## Required Vercel environment variables

Configure these in the Vercel project settings for each environment you use:

- `FCM_SERVICE_ACCOUNT_JSON`: the Firebase service account JSON with the required Firebase Admin access. Keep it only in Vercel; never commit it to GitHub or place it in dashboard code.
- `BROADCAST_ADMIN_EMAIL`: the single verified administrator email address.
- `ALLOWED_ORIGINS`: comma-separated exact origins serving the dashboard, for example `https://evlt-admin.web.app,https://evlt-admin.firebaseapp.com`. Add the actual production and preview origins that should be allowed. Do not use `*`.

The endpoint rejects requests if the origin or administrator allowlist is missing. It verifies the Firebase ID token, requires a verified email, and checks for an exact match with `BROADCAST_ADMIN_EMAIL`. It does not accept a shared client secret.

## Firebase setup

In Firebase Console for `evlt-admin`, enable the Google sign-in provider under Authentication. Add the dashboard's hosting domains to Authorized domains. The administrator must use a verified Google account whose email appears in `BROADCAST_ALLOWED_EMAILS`.

## Deploying

After reviewing and merging the code, set the Vercel environment variables and redeploy the API project. Then update the dashboard deployment separately. Until both deployments are complete, in-app notifications continue to work, but background push delivery may not.

The service account currently needs access to read `push_tokens` and send FCM messages. Reduce its IAM/database privileges to the minimum required for the deployment.
