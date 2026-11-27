/**
 * Singleton SSE manager for /api/events.
 */
const EVENT_NAMES = [
  "hello",
  "scheduler",
  "config_changed",
  "run_queued",
  "run_started",
  "run_finished",
  "tasks_changed",
  "alerts_changed",
];

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

    for (const type of EVENT_NAMES) {
      es.addEventListener(type, (ev) => {
        let payload = null;
        if (ev.data) {
          try {
            payload = JSON.parse(ev.data);
          } catch {
            payload = ev.data;
          }
        }
        this.emit(type, payload);
        this.emit("*", { type, payload });
      });
    }

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
