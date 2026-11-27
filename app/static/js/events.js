/** Global SSE event bus with exponential backoff and polling fallback. */

const listeners = new Set();
let es = null;
let retryDelayMs = 1000;
let consecutiveFailures = 0;
let reconnectTimer = null;
let fallbackPollTimer = null;

function dispatch(ev) {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {}
  }
}

function startFallbackPolling() {
  if (fallbackPollTimer) return;
  fallbackPollTimer = setInterval(() => {
    dispatch({ type: "poll_tick" });
  }, 15000);
}

function stopFallbackPolling() {
  if (!fallbackPollTimer) return;
  clearInterval(fallbackPollTimer);
  fallbackPollTimer = null;
}

function connect() {
  if (es) {
    es.close();
    es = null;
  }
  try {
    es = new EventSource("/api/events");
  } catch {
    startFallbackPolling();
    return;
  }

  es.onopen = () => {
    consecutiveFailures = 0;
    retryDelayMs = 1000;
    stopFallbackPolling();
  };

  es.onmessage = (msgEv) => {
    consecutiveFailures = 0;
    retryDelayMs = 1000;
    stopFallbackPolling();
    try {
      const data = JSON.parse(msgEv.data);
      dispatch(data);
    } catch {}
  };

  es.onerror = () => {
    if (es) {
      es.close();
      es = null;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= 3) {
      startFallbackPolling();
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, retryDelayMs);
    retryDelayMs = Math.min(30000, retryDelayMs * 2);
  };
}

export function startEvents() {
  connect();
}

export function onGlobalEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
