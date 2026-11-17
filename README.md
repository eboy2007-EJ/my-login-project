# Risen Logins

## Requirements

- Node.js 20.19 or newer
- A MongoDB Atlas cluster (or another MongoDB deployment)

## Configure environment variables

Copy `.env.example` to `.env` for local development and replace the example values:

- `DATABASE_URL`: MongoDB connection string with the target database in its path.
- `DATABASE_NAME`: database name to use if it is not included in the connection string.
- `JWT_SECRET`: a private random secret of at least 32 bytes. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
- `PORT`: local server port.
- `APP_NAME` and `SUPPORT_EMAIL`: used in reset-code emails.
- `GMAIL_USER` and `GMAIL_APP_PASSWORD`: Gmail SMTP credentials for password recovery.

Do not commit `.env` or paste real credentials into source code. `.env.example` contains placeholders only. In MongoDB Atlas, create a database user and allow the server's IP address to connect. Use a least-privilege database user.

URL-encode special characters in the Atlas username or password before placing them in `DATABASE_URL`.

On Render, add these values under the service's **Environment** settings. Set `NODE_ENV` to `production` so the authentication cookie is marked secure.

## Migrate existing SQLite accounts

If you have accounts in the existing `database.db`, configure `.env` with the MongoDB settings, then run this once before deploying the MongoDB-backed version:

```sh
npm run migrate:sqlite
```

The migration copies email addresses, bcrypt password hashes, and any pending reset-code state. It does not copy plaintext passwords. Existing MongoDB accounts with the same email are left unchanged. If SQLite contains email addresses that differ only by letter case, the migration stops and reports the conflict instead of merging accounts.

Keep a secure backup of `database.db` until you have verified that migrated users can sign in. The migration script is safe to rerun: it does not overwrite existing MongoDB accounts.

## Run locally

```sh
npm install
npm start
```

Registration and login create an HTTP-only JWT cookie that expires after one hour. The dashboard checks the cookie with `/me` when the page loads; logout clears it.

## Gmail password reset setup

Password reset emails use Gmail SMTP. Enable 2-Step Verification and create a Google App Password for the sending account. Set `GMAIL_USER` and `GMAIL_APP_PASSWORD` in the environment. Never use your normal Gmail password.

Reset codes expire after 10 minutes, can be attempted at most five times, and can be requested once per minute for each account.
