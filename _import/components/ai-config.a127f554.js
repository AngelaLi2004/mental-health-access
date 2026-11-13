// Where the chat sends questions for an AI-written answer.
// Empty means the built-in lookup answers (no AI, nothing leaves the browser).
// On this computer, the chat backend in dashboard/worker runs at port 8787 (npm run dev there),
// so the local preview uses AI while the public site keeps the lookup until the Worker is deployed.
// After deploying, set PUBLIC_ENDPOINT to the Worker's URL, e.g. "https://mental-health-chat.<subdomain>.workers.dev/chat".
const PUBLIC_ENDPOINT = "";
const isLocal = ["localhost", "127.0.0.1"].includes(globalThis.location?.hostname);
export const AI_ENDPOINT = isLocal ? "http://127.0.0.1:8787/chat" : PUBLIC_ENDPOINT;
