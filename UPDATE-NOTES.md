# Laptop Guardian — updated feature build

This update adds:

- **Device Offline / Reconnect Alerts:** server checks agent heartbeat status every 5 seconds; a device is considered offline after 35 seconds without a heartbeat. The owner receives an email on offline and reconnect transitions when Resend is configured. Duplicate alerts are prevented by tracking the last notified state per device.
- **Guest Mode:** read-only dashboard access. Backend authorization blocks pairing, device commands, unpairing, and test-email sends for guest tokens.
- **Guardian AI:** a local, context-aware troubleshooting assistant for heartbeat/offline status, lock command activity, email configuration, and device summaries. This is rule-based and does not call an external LLM.
- **Lock-result email:** lock command success/failure email alert retained in the updated backend.

## Safe update instructions (Windows)

1. Stop only the backend server with `Ctrl+C` in the backend terminal. Do **not** stop the Windows Agent terminal.
2. Back up the existing project folder.
3. Extract this ZIP over the existing `laptop guardian` folder and allow code files to merge/replace.
4. Keep your existing `backend/.env` and `backend/data/` files. They are intentionally excluded from this ZIP because they contain credentials and local account/device data.
5. In the backend terminal run `npm.cmd start`.
6. Open `http://localhost:8787`, sign in as Owner, then test the features below.

If setting up a fresh copy instead of updating an existing one, copy `backend/.env.example` to `backend/.env`, generate a new random `JWT_SECRET` of at least 32 characters, and configure `RESEND_API_KEY` and `EMAIL_FROM`. Never paste secrets into chat or commit `.env`.

## Test checklist

- **Offline alert:** sign in as Owner, confirm agent is running, then stop the agent temporarily. Wait over 35 seconds and check the backend terminal, Activity Log, and owner inbox. Restart the agent and verify a reconnect email.
- **Guest Mode:** sign out and choose “Continue in Guest Mode (read-only)”. Device information and activity should be viewable, but device-management controls are hidden and backend mutation requests are rejected.
- **Guardian AI:** open the Guardian AI section and ask “Why is my device offline?”, “Did the lock command work?”, or “Are email alerts configured?”.
- **Lock alert:** from Owner Mode, send a lock command and verify the backend logs the email trigger and the inbox receives the message.

The backend continues to bind to `127.0.0.1` only. Do not expose it to the public internet without a secure deployment design and HTTPS.
