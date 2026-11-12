# Login Project

## Gmail password reset setup

Password reset emails are sent through Gmail SMTP. Do not put your Gmail password or app password in source code.

1. Enable 2-Step Verification on the Gmail account that will send reset emails.
2. Create a Google App Password for the app. Use that 16-character app password, not the normal Gmail password.
3. Configure these environment variables on the server:
   - `GMAIL_USER`: the sending Gmail address.
   - `GMAIL_APP_PASSWORD`: the Google App Password.
4. On Render, add both values under the service's **Environment** settings, then redeploy.

For local development, set both values as environment variables in your shell or secret manager before running `npm start`. Do not commit credentials.

Reset codes expire after 10 minutes, can be attempted at most five times, and can be requested once per minute for each account.
