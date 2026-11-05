// The chat page's client. It reads the AI SDK UI message stream (server-sent
// events) from POST /chat and renders each delta as it arrives. Model output
// is inserted through textContent only, so it can never become markup.
//
// The server keeps no conversation: the page resends earlier turns as
// `history`, within the limits POST /chat accepts.
const MAX_HISTORY_TURNS = 40;
const MAX_HISTORY_CHARS = 50_000;

const form = document.getElementById('ask');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
const reset = document.getElementById('reset');
const log = document.getElementById('log');
const contextLabel = document.getElementById('context');
const contextMeter = document.getElementById('context-meter');
const sessionLabel = document.getElementById('session');

const number = new Intl.NumberFormat();
let history = [];
let session = { input: 0, output: 0 };
let contextTokens = null;
let controller;

function line(className, text = '') {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  log.append(div);
  return div;
}

/** Drops the oldest exchanges until the history fits what the route accepts. */
function trimHistory() {
  const chars = () => history.reduce((sum, turn) => sum + turn.content.length, 0);
  while (history.length > MAX_HISTORY_TURNS || chars() > MAX_HISTORY_CHARS) history.splice(0, 2);
}

function showSession() {
  sessionLabel.textContent = `${number.format(session.input)} in · ${number.format(session.output)} out`;
}

/** The last request's input plus output is what it occupied of the context window. */
function showContext(usage) {
  const used = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (contextTokens === null) {
    contextLabel.textContent = `${number.format(used)} tokens in the last request (window size unknown: set AI_COMPAT_CONTEXT_TOKENS)`;
    contextMeter.value = 0;
    return;
  }
  const share = used / contextTokens;
  contextLabel.textContent = `${number.format(used)} of ${number.format(contextTokens)} tokens (${(share * 100).toFixed(1)}%) in the last request`;
  contextMeter.value = Math.min(share, 1);
}

function render(part, turn) {
  if (part.type === 'reasoning-delta') {
    turn.thinking ??= turn.answer.parentNode.insertBefore(line('thinking'), turn.answer);
    turn.thinking.textContent += part.delta;
  } else if (part.type === 'text-delta') {
    turn.answer.textContent += part.delta;
  } else if (part.type === 'tool-input-available') {
    line('note', `Calling tool ${part.toolName}…`);
  } else if (part.type === 'error') {
    turn.failed = true;
    line('error', part.errorText);
  } else if (part.type === 'finish') {
    if (part.finishReason === 'length') line('note', 'Stopped at the output-token limit.');
    else if (part.finishReason !== 'stop') line('note', `Finished: ${part.finishReason}.`);
    const usage = part.messageMetadata?.usage;
    if (usage !== undefined) {
      const reasoning =
        usage.reasoningTokens === undefined
          ? ''
          : ` (${number.format(usage.reasoningTokens)} reasoning)`;
      line(
        'usage',
        `${number.format(usage.inputTokens ?? 0)} in · ${number.format(usage.outputTokens ?? 0)} out${reasoning}`,
      );
      session.input += usage.inputTokens ?? 0;
      session.output += usage.outputTokens ?? 0;
      showSession();
      showContext(usage);
    }
  }
}

async function ask(text) {
  line('you', text);
  const turn = { answer: line('answer'), failed: false };
  controller = new AbortController();
  send.disabled = true;
  stop.disabled = false;
  try {
    const response = await fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: text, history }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      line('error', `${response.status} ${problem.detail ?? problem.title ?? response.statusText}`);
      return;
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        for (const field of event.split('\n')) {
          if (!field.startsWith('data: ')) continue;
          const data = field.slice(6);
          if (data !== '[DONE]') render(JSON.parse(data), turn);
        }
      }
    }
    // Only a turn that produced an answer joins the conversation.
    const answer = turn.answer.textContent;
    if (!turn.failed && answer !== '') {
      history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
      trimHistory();
    }
  } catch (error) {
    line('error', error.name === 'AbortError' ? 'Stopped.' : String(error));
  } finally {
    send.disabled = false;
    stop.disabled = true;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (text === '') return;
  prompt.value = '';
  void ask(text);
});

// Enter sends; Shift+Enter keeps a new line, and an IME composition is never cut short.
prompt.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!send.disabled) form.requestSubmit();
});

stop.addEventListener('click', () => controller?.abort());

reset.addEventListener('click', () => {
  controller?.abort();
  history = [];
  session = { input: 0, output: 0 };
  log.replaceChildren();
  contextLabel.textContent = 'no request yet';
  contextMeter.value = 0;
  showSession();
});

try {
  const response = await fetch('/chat/model');
  if (response.ok) ({ contextTokens } = await response.json());
} catch {
  // The counters still work without a window size.
}
