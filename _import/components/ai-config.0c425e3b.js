// Where the chat sends questions for an AI-written answer: the Cloudflare Worker in dashboard/worker,
// which holds the Groq key as a secret. It only accepts requests from the public site and the local preview.
// Set to "" to turn AI off; the chat then answers from the built-in lookup and nothing leaves the browser.
export const AI_ENDPOINT = "https://mental-health-chat.mental-health-chat.workers.dev/chat";
