# Deployment

The app can use SQLite for local development and PostgreSQL when `DATABASE_URL` is set. Production startup requires PostgreSQL, HTTPS, and configured Google OAuth credentials.

## Render setup

1. Push this folder to a Git repository and connect that repository to Render.
2. Create a Render PostgreSQL database in Frankfurt. For a small launch, the lowest paid plan (`0.1c-256mb`) with a 1 GB disk is the starting configuration; confirm current pricing in Render before creating it.
3. Before deploying the web service or directing users to it, migrate the existing SQLite database into the empty PostgreSQL database. Set `DATABASE_URL` to the database's private connection URL and `DATABASE_PATH` to the local SQLite file, then run:

   ```powershell
   npm run migrate:postgres -- --confirm
   ```

   The command requires `--confirm`, refuses a non-empty target, copies users and related records, and leaves the SQLite source unchanged. Do not commit the connection URL or `.env`.
4. Deploy the web service from [`render.yaml`](./render.yaml). It uses the lowest paid web plan (`0.5c-512mb`) in Frankfurt, builds with `npm ci`, starts with `npm start`, and checks `/healthz`. The Blueprint intentionally does not create a database; supply the already-migrated database's private URL when Render prompts for `DATABASE_URL`.
5. Set `APP_BASE_URL` to the service's HTTPS URL, then add `https://<your-service-domain>/auth/google/callback` to the Google OAuth client's authorized redirect URIs. The app derives `GOOGLE_CALLBACK_URL` from `APP_BASE_URL` unless explicitly overridden.

The app creates/updates its PostgreSQL schema during startup. The database migration must finish before the service receives signups so new queue numbers continue after existing registrations. Set `NODE_ENV=production`, `TRUST_PROXY=1`, and the Google client ID/secret when syncing the Blueprint.

Render's free web services can spin down while idle, and free Postgres databases expire after 30 days. Treat those tiers as temporary previews, not durable production storage. Confirm current Render pricing and select service/database plans before deploying; this project does not provision cloud resources.
