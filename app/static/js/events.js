/**
 * Singleton SSE manager for /api/events.
 * Backend emits unnamed SSE JSON frames: data: {"type": "...", ...}
 */
class EventBus {
  constructor() {
    this.es = null;
    this.listeners = new Map();
    this.started = false;
  }

  start() {
    if (this.started || typeof EventSource === "undefined") return;
    this.started = true;
    this.lastAuthCheckTs = 0;
    const es = new EventSource("/api/events");
    this.es = es;

    es.onopen = () => {
      this.emit("connected", {});
    };

    es.onmessage = (ev) => {
      if (!ev.data) return;
      let payload = null;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      const type = payload && typeof payload === "object" ? payload.type : null;
      if (type) {
        this.emit(type, payload);
        this.emit("*", { type, payload });
      }
    };

    es.onerror = () => {
      this.emit("connection_error", {});
      const now = Date.now();
      if (now - this.lastAuthCheckTs > 15000) {
        this.lastAuthCheckTs = now;
        fetch("/api/auth/status", { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : null))
          .then((st) => {
            if (st && !st.auth_disabled && !st.authenticated) {
              this.stop();
              location.replace(st.configured ? "/login" : "/setup");
            }
          })
          .catch(() => {});
      }
    };
  }

  stop() {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.started = false;
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events:${type}]`, err);
      }
    }
  }
}

export const events = new EventBus();
