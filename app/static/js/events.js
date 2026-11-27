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
    const es = new EventSource("/api/events");
    this.es = es;

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
      // Browser EventSource handles backoff automatically unless closed.
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
