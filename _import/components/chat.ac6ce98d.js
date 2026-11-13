// The chat panel, shared by the map page (as a pop-up) and the standalone chat page (full screen).
// Answers come from the built-in lookup; when an AI endpoint is set, the lookup's figures are sent
// with the question so the AI writes a short answer from those figures only.

const CRISIS = /suicid|kill (myself|me)|end my life|self[- ]?harm|hurt myself|want to die|自杀|轻生|伤害自己|不想活/i;
const CHAT_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 6.5a1.5 1.5 0 1 0 0 .01Zm5 0a1.5 1.5 0 1 0 0 .01Zm5 0a1.5 1.5 0 1 0 0 .01Z"/></svg>';

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const textP = (text) => el("p", {textContent: text});

/**
 * answer(text, defaults) -> lookup result {text, items?, ordered?, suggestions?}
 * defaults() -> {service, minutes}
 * facts(result) -> text the AI may use
 * openPlace(place) -> show a place ({level, id}) on the map
 */
export function createChat({answer, defaults, facts, openPlace, endpoint = "", examples = [], standalone = false}) {
  const log = el("div", {className: "chat-log"});
  log.setAttribute("aria-live", "polite");
  const input = el("input", {type: "text", className: "chat-input", placeholder: "Ask about a place…", maxLength: 300});
  input.setAttribute("aria-label", "Ask a question");
  const send = el("button", {type: "button", className: "chat-send", textContent: "➤"});
  send.setAttribute("aria-label", "Send");
  const close = standalone ? null : el("button", {type: "button", className: "chat-close", textContent: "×"});
  close?.setAttribute("aria-label", "Close");
  const head = el("div", {className: "chat-head"}, [
    el("div", {}, [
      el("strong", {textContent: "Ask about the data"}),
      el("span", {textContent: endpoint ? "AI answers from this map's data" : "Answers from this map's data"})
    ]),
    ...(close ? [close] : [])
  ]);
  const foot = el("div", {className: "chat-foot", textContent: `${endpoint ? "Questions go to an AI service to write the answer. " : ""}Not medical advice. In a crisis, call or text 988.`});
  const panel = el("div", {className: standalone ? "chat-panel standalone" : "chat-panel"}, [head, log, el("div", {className: "chat-row"}, [input, send]), foot]);
  panel.setAttribute("role", standalone ? "main" : "dialog");
  panel.setAttribute("aria-label", "Ask about the data");
  if (!standalone) panel.hidden = true;

  const fab = standalone ? null : el("button", {type: "button", className: "chat-fab"});
  if (fab) {
    fab.setAttribute("aria-label", "Ask about the data");
    fab.innerHTML = `${CHAT_ICON}<span>Ask</span>`;
  }

  function toggle(open = panel.hidden) {
    if (standalone) return;
    panel.hidden = !open;
    fab.hidden = open;
    if (open) input.focus();
  }
  if (fab) fab.onclick = () => toggle(true);
  if (close) close.onclick = () => toggle(false);

  function bubble(role, children) {
    const box = el("div", {className: `chat-bubble ${role}`}, children);
    log.append(box);
    log.scrollTop = log.scrollHeight;
    return box;
  }
  const chips = (list) => el("div", {className: "chat-chips"}, list.map((example) => el("button", {type: "button", className: "chat-chip", textContent: example, onclick: () => ask(example)})));
  const placeButton = (item, className, label) => {
    const button = el("button", {type: "button", className, textContent: label, title: "Show on the map"});
    button.onclick = () => openPlace(item.place);
    return button;
  };
  // Without AI: the full list, each place clickable.
  function placeList(result) {
    if (!result.items?.length) return [];
    return [el(result.ordered ? "ol" : "ul", {}, result.items.map((item) => el("li", {}, [
      item.place ? placeButton(item, "chat-place", item.label) : el("strong", {textContent: item.label}),
      ...(item.value ? [document.createTextNode(` ${item.value}`)] : [])
    ])))];
  }
  // With AI: the answer already gives the numbers, so places are just small buttons.
  function placeButtons(result) {
    const places = (result.items ?? []).filter((item) => item.place);
    return places.length ? [el("div", {className: "chat-chips"}, places.map((item) => placeButton(item, "chat-chip place", `📍 ${item.label}`)))] : [];
  }

  async function ask(question) {
    const text = question.trim();
    if (!text) return;
    input.value = "";
    bubble("user", [textP(text)]);
    if (CRISIS.test(text)) {
      return bubble("bot crisis", [
        textP("If you're thinking about suicide or hurting yourself, please reach out now. Call or text 988 (Suicide & Crisis Lifeline), any time. If you're in immediate danger, call 911."),
        el("a", {href: "https://988lifeline.org", target: "_blank", rel: "noopener noreferrer", textContent: "988lifeline.org"})
      ]);
    }
    const result = answer(text, defaults());
    const lookupOnly = () => [textP(result.text), ...placeList(result), ...(result.suggestions ? [chips(examples.slice(0, 4))] : [])];
    if (!endpoint) return bubble("bot", lookupOnly());
    const pending = bubble("bot", [textP("…")]);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({question: text, facts: facts(result)}),
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error(String(response.status));
      const {answer: reply} = await response.json();
      pending.replaceChildren(...(reply ? [textP(reply), ...placeButtons(result)] : lookupOnly()));
    } catch {
      // If the AI is busy or out of its free daily allowance, fall back to the lookup.
      pending.replaceChildren(...lookupOnly());
    }
    log.scrollTop = log.scrollHeight;
  }

  send.onclick = () => ask(input.value);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") ask(input.value);
  });
  if (!standalone) {
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) toggle(false);
    });
  }
  bubble("bot", [textP("Hi! Ask about access in a state or county, or which places have the lowest access."), chips(examples.slice(0, 4))]);
  return {panel, fab, ask, open: () => toggle(true)};
}
