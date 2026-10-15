# Laptop Guardian Windows Agent

Requirements: Node.js 18+ (Node.js 20 or 22 LTS recommended). The agent uses Node built-ins only.

## Pair this device
1. Start the backend and sign in to the dashboard.
2. Choose **Pair a device** and generate a six-digit code.
3. Open PowerShell in this folder and run `node agent.js pair 123456`, replacing the example with the current code.
4. Keep the terminal open. The agent sends a heartbeat every 10 seconds and polls for owner-authorized commands every 5 seconds.

To restart an already paired agent, run `node agent.js`. The private `.agent-config.json` is created on pairing and must not be shared. Unpairing the device in the dashboard revokes its token.

The default API URL is `http://localhost:8787`, for same-computer local testing. For a different computer, set `LG_API_URL` to the backend's reachable HTTPS URL before pairing; do not expose this local development server to the public internet. The current backend binds to localhost only.

Supported commands: status refresh and Windows session lock. Locking does not bypass Windows sign-in or remotely unlock the computer.
