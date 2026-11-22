# Deployment

The app can use SQLite for local development and PostgreSQL when `DATABASE_URL` is set. Production startup requires PostgreSQL, HTTPS, and configured Google OAuth credentials.

## Deploy on Vercel

Vercel runs the Express app as a Function. The `vercel-build` script copies the public site pages and assets into `public/`; it intentionally excludes `waitlist.html`, which stays behind the authenticated Express route. Vercel does not serve the app's `express.static()` middleware.

1. Import the project from GitHub in Vercel, or deploy the project folder with the Vercel CLI. Keep `server.js`, `vercel.json`, and `package-lock.json` at the project root.
2. Add PostgreSQL through a Vercel Marketplace integration such as Neon. Vercel Postgres is no longer offered as a first-party database. Use the provider's pooled connection URL for serverless functions.
3. If you have local SQLite registrations to preserve, put the provider's external `DATABASE_URL` in the ignored local `.env` and run `npm run migrate:postgres -- --confirm`. The migration requires an empty database and leaves SQLite untouched. Skip it if there is no data to retain.
4. In Vercel **Settings → Environment Variables**, set `DATABASE_URL`, `APP_BASE_URL=https://<your-production-domain>`, and `TRUST_PROXY=1` for Production. Also set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Set a separate PostgreSQL URL for Preview deployments, or disable previews; don't point previews at production data.
5. Enable Vercel's system environment variables. Add `https://<your-production-domain>/auth/google/callback` to the authorized redirect URIs in Google Cloud. `GOOGLE_CALLBACK_URL` is derived from `APP_BASE_URL` unless explicitly set.
6. Deploy and check `https://<your-production-domain>/healthz`. It should return `{"status":"ok"}`.

Vercel Express deployments run within Function limits and may scale across instances. The current sign-in rate limiter uses in-memory storage, so it is per-instance rather than shared across all scaled functions. Review Vercel and database-provider pricing before launch.

## Add PostgreSQL to an already deployed Render service

1. In the Render Dashboard, choose **New + > Postgres**. Create a paid database in the same region as the web service (Frankfurt in the current Blueprint). Wait for its status to become **Available**.
2. If you have local SQLite registrations to preserve, run the migration before pointing the web service at the database:
   - In the database's **Connect** menu, copy the **External Database URL**. A local computer cannot use Render's internal URL.
   - If external access is restricted, temporarily allow only your current public IP in the database's **Networking** settings.
   - In the ignored local `.env` file, temporarily set `DATABASE_URL` to the external URL. The migration script defaults to `data\dart.sqlite`; set `DATABASE_PATH` there too only if your database file is elsewhere.
   - From the project folder, run `npm run migrate:postgres -- --confirm`. The script refuses a non-empty PostgreSQL target and leaves SQLite untouched.
   - Remove the temporary external URL from `.env` afterward. Don't paste it into chat or commit it.
   If there are no local registrations to preserve, skip the migration; the app creates an empty schema at startup.
3. Open the Render web service's **Environment** settings and add `DATABASE_URL` using the database's **Internal Database URL** from the **Connect** menu. Keep the web service and database in the same region. The internal URL is preferred for the running app.
4. Confirm the web service also has `NODE_ENV=production`, `TRUST_PROXY=1`, `APP_BASE_URL=https://<your-service-domain>`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`. The app derives its OAuth callback as `https://<your-service-domain>/auth/google/callback`; add that exact URI to the Google OAuth client's authorized redirect URIs.
5. Save the environment changes and redeploy/restart the service. Check **Logs** for a successful startup, then open `https://<your-service-domain>/healthz`; it should return `{"status":"ok"}`.

## Render setup

1. Push this folder to a Git repository and connect that repository to Render.
2. Create a Render PostgreSQL database in Frankfurt. For a small launch, the lowest paid plan (`0.1c-256mb`) with a 1 GB disk is the starting configuration; confirm current pricing in Render before creating it.
3. Before deploying the web service or directing users to it, migrate the existing SQLite database into the empty PostgreSQL database. From your local computer, use the database's External Database URL for this one-time migration, then use its Internal Database URL for the deployed service:

   ```powershell
   npm run migrate:postgres -- --confirm
   ```

   The command requires `--confirm`, refuses a non-empty target, copies users and related records, and leaves the SQLite source unchanged. Do not commit the connection URL or `.env`.
4. Deploy the web service from [`render.yaml`](./render.yaml). It uses the lowest paid web plan (`0.5c-512mb`) in Frankfurt, builds with `npm ci`, starts with `npm start`, and checks `/healthz`. The Blueprint intentionally does not create a database; supply the already-migrated database's private URL when Render prompts for `DATABASE_URL`.
5. Set `APP_BASE_URL` to the service's HTTPS URL, then add `https://<your-service-domain>/auth/google/callback` to the Google OAuth client's authorized redirect URIs. The app derives `GOOGLE_CALLBACK_URL` from `APP_BASE_URL` unless explicitly overridden.

The app creates/updates its PostgreSQL schema during startup. The database migration must finish before the service receives signups so new queue numbers continue after existing registrations. Set `NODE_ENV=production`, `TRUST_PROXY=1`, and the Google client ID/secret when syncing the Blueprint.

Render's free web services can spin down while idle, and free Postgres databases expire after 30 days. Treat those tiers as temporary previews, not durable production storage. Confirm current Render pricing and select service/database plans before deploying; this project does not provision cloud resources.
