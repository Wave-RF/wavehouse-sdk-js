import { describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamStatus, WaveHouseError } from "../types.js";
import type { StreamTransport } from "./controller.js";
import { StreamController } from "./controller.js";

function makeTransport<T = Record<string, unknown>>(): StreamTransport<T> & {
  fireEvent(e: StreamEvent<T>): void;
  fireStatus(s: StreamStatus): void;
  fireError(e: WaveHouseError): void;
} {
  const t: StreamTransport<T> & {
    fireEvent(e: StreamEvent<T>): void;
    fireStatus(s: StreamStatus): void;
    fireError(e: WaveHouseError): void;
  } = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onEvent: null,
    onStatus: null,
    onError: null,
    fireEvent(e: StreamEvent<T>) {
      this.onEvent?.(e);
    },
    fireStatus(s: StreamStatus) {
      this.onStatus?.(s);
    },
    fireError(e: WaveHouseError) {
      this.onError?.(e);
    },
  };
  return t;
}

const event1: StreamEvent = {
  table: "clicks",
  timestamp: "2024-01-01T00:00:00Z",
  data: { page: "/a" },
};
const event2: StreamEvent = {
  table: "clicks",
  timestamp: "2024-01-01T00:00:01Z",
  data: { page: "/b" },
};

describe("StreamController", () => {
  it("calls transport.connect() on construction", () => {
    const t = makeTransport();
    new StreamController(t);
    expect(t.connect).toHaveBeenCalledOnce();
  });

  it("initial status is connecting", () => {
    const t = makeTransport();
    const ctrl = new StreamController(t);
    expect(ctrl.status).toBe("connecting");
  });

  describe("subscribe()", () => {
    it("invokes next callback for each event", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const next = vi.fn();

      ctrl.subscribe({ next });
      t.fireEvent(event1);
      t.fireEvent(event2);

      expect(next).toHaveBeenCalledTimes(2);
      expect(next).toHaveBeenCalledWith(event1);
      expect(next).toHaveBeenCalledWith(event2);
    });

    it("fires status callback immediately with current status", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const status = vi.fn();

      ctrl.subscribe({ next: vi.fn(), status });
      expect(status).toHaveBeenCalledWith("connecting");
    });

    it("fires status callback on status changes", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const status = vi.fn();

      ctrl.subscribe({ next: vi.fn(), status });
      t.fireStatus("live");

      expect(status).toHaveBeenCalledWith("live");
      expect(ctrl.status).toBe("live");
    });

    it("fires error callback", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const error = vi.fn();

      ctrl.subscribe({ next: vi.fn(), error });
      const err: WaveHouseError = {
        status: 0,
        code: "STREAM_ERROR",
        message: "Stream error",
        retryable: true,
      };
      t.fireError(err);

      expect(error).toHaveBeenCalledWith(err);
    });

    it("returns an unsubscribe function", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const next = vi.fn();

      const unsub = ctrl.subscribe({ next });
      t.fireEvent(event1);
      unsub();
      t.fireEvent(event2);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("auto-closes when last subscriber unsubscribes", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);

      const unsub = ctrl.subscribe({ next: vi.fn() });
      unsub();

      expect(t.disconnect).toHaveBeenCalled();
    });

    it("delivers to multiple subscribers", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const next1 = vi.fn();
      const next2 = vi.fn();

      ctrl.subscribe({ next: next1 });
      ctrl.subscribe({ next: next2 });
      t.fireEvent(event1);

      expect(next1).toHaveBeenCalledWith(event1);
      expect(next2).toHaveBeenCalledWith(event1);
    });
  });

  describe("close()", () => {
    it("disconnects the transport", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      ctrl.close();
      expect(t.disconnect).toHaveBeenCalled();
    });

    it("resolves pending async iterator waiters with done", async () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const iter = ctrl[Symbol.asyncIterator]();

      const promise = iter.next();
      ctrl.close();

      const result = await promise;
      expect(result.done).toBe(true);
    });
  });

  describe("async iterator", () => {
    it("yields buffered events immediately", async () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);

      // Fire events before creating the iterator
      t.fireEvent(event1);
      t.fireEvent(event2);

      const iter = ctrl[Symbol.asyncIterator]();
      const r1 = await iter.next();
      const r2 = await iter.next();

      expect(r1.value).toEqual(event1);
      expect(r2.value).toEqual(event2);
    });

    it("waits for future events", async () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const iter = ctrl[Symbol.asyncIterator]();

      const promise = iter.next();

      // Event arrives after we start waiting
      t.fireEvent(event1);

      const result = await promise;
      expect(result.value).toEqual(event1);
      expect(result.done).toBe(false);
    });

    it("returns done after close", async () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const iter = ctrl[Symbol.asyncIterator]();

      ctrl.close();

      const result = await iter.next();
      expect(result.done).toBe(true);
    });

    it("returns done when status is closed", async () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const iter = ctrl[Symbol.asyncIterator]();

      const promise = iter.next();
      t.fireStatus("closed");

      const result = await promise;
      expect(result.done).toBe(true);
    });

    it("return() closes the stream", async () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const iter = ctrl[Symbol.asyncIterator]();

      const result = await iter.return!();
      expect(result.done).toBe(true);
      expect(t.disconnect).toHaveBeenCalled();
    });

    it("supports for-await-of pattern", async () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const received: StreamEvent[] = [];

      // Fire events then close
      t.fireEvent(event1);
      t.fireEvent(event2);
      // Close after events are buffered so the loop terminates
      t.fireStatus("closed");

      for await (const event of ctrl) {
        received.push(event);
      }

      expect(received).toEqual([event1, event2]);
    });
  });

  describe("buffering", () => {
    // Reaches into the private queue: its size is the thing under test, and
    // there is no public way to observe memory a callback consumer never reads.
    const queued = (c: unknown) => (c as { _buffer: unknown[] })._buffer.length;

    it("does not queue events for a callback-only subscriber", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      ctrl.subscribe({ next: () => {} });
      for (let i = 0; i < 1000; i++) t.fireEvent(event1);
      expect(queued(ctrl)).toBe(0);
    });

    it("drops events queued before the first subscriber when nobody iterates", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      t.fireEvent(event1);
      expect(queued(ctrl)).toBe(1);
      ctrl.subscribe({ next: () => {} });
      expect(queued(ctrl)).toBe(0);
    });

    it("still queues for an iterator started after events and a subscriber", async () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const iter = ctrl[Symbol.asyncIterator]();
      ctrl.subscribe({ next: () => {} });
      t.fireEvent(event1);
      expect((await iter.next()).value).toEqual(event1);
      t.fireEvent(event2);
      expect(queued(ctrl)).toBe(1);
    });

    it("clears the queue on close() of a callback-only stream", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const unsub = ctrl.subscribe({ next: () => {} });
      unsub();
      expect(ctrl.status).toBe("closed");
      expect(queued(ctrl)).toBe(0);
    });

    it("lets an iterator drain what was queued before close()", async () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      t.fireEvent(event1);
      ctrl.close();
      const seen: StreamEvent[] = [];
      for await (const e of ctrl) seen.push(e);
      expect(seen).toEqual([event1]);
    });
  });

  describe("a throwing subscriber", () => {
    const boom = () => {
      throw new Error("boom");
    };

    it("does not stop delivery to later subscribers on next, status or error", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const t = makeTransport();
      const ctrl = new StreamController(t);
      ctrl.subscribe({ next: boom, status: boom, error: boom });
      const next = vi.fn();
      const status = vi.fn();
      const error = vi.fn();
      ctrl.subscribe({ next, status, error });
      status.mockClear();

      t.fireEvent(event1);
      t.fireStatus("live");
      const err: WaveHouseError = { status: 0, code: "X", message: "m", retryable: true };
      t.fireError(err);

      expect(next).toHaveBeenCalledWith(event1);
      expect(status).toHaveBeenCalledWith("live");
      expect(error).toHaveBeenCalledWith(err);
    });

    it("still hands the event to a concurrent for-await", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const pending = ctrl[Symbol.asyncIterator]().next();
      ctrl.subscribe({ next: boom });
      t.fireEvent(event1);
      expect((await pending).value).toEqual(event1);
    });

    it("still ends a for-await on the closed status when a status handler throws", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const t = makeTransport();
      const ctrl = new StreamController(t);
      ctrl.subscribe({ next: () => {}, status: boom });
      const pending = ctrl[Symbol.asyncIterator]().next();
      t.fireStatus("closed");
      expect((await pending).done).toBe(true);
    });

    it("does not escape subscribe() when the initial status call throws", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ctrl = new StreamController(makeTransport());
      let unsub: (() => void) | undefined;
      expect(() => {
        unsub = ctrl.subscribe({ next: () => {}, status: boom });
      }).not.toThrow();
      expect(typeof unsub).toBe("function");
    });

    it("lets the status handler throw before connected() without breaking it", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const t = makeTransport();
      const ctrl = new StreamController(t);
      ctrl.subscribe({ next: () => {}, status: boom });
      const p = ctrl.connected();
      t.fireStatus("live");
      await expect(p).resolves.toBeUndefined();
    });
  });

  describe("a terminal error before subscribe()", () => {
    const terminal: WaveHouseError = {
      status: 400,
      code: "HTTP_400",
      message: "bad",
      retryable: false,
    };

    it("is replayed to a subscriber that registers after the stream closed", async () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      t.fireError(terminal);
      t.fireStatus("closed");
      await Promise.resolve(); // any await between stream() and subscribe()
      const error = vi.fn();
      ctrl.subscribe({ next: () => {}, error });
      expect(error).toHaveBeenCalledExactlyOnceWith(terminal);
    });

    it("reaches an early subscriber exactly once", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      const error = vi.fn();
      ctrl.subscribe({ next: () => {}, error });
      t.fireError(terminal);
      t.fireStatus("closed");
      expect(error).toHaveBeenCalledTimes(1);
    });

    it("does not replay an error the stream recovered from", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      t.fireError({ ...terminal, status: 0, retryable: true });
      t.fireStatus("live");
      ctrl.close();
      const error = vi.fn();
      ctrl.subscribe({ next: () => {}, error });
      expect(error).not.toHaveBeenCalled();
    });

    it("does not replay to a subscriber of a stream the caller closed", () => {
      const t = makeTransport();
      const ctrl = new StreamController(t);
      t.fireError({ ...terminal, status: 0, retryable: true });
      ctrl.close();
      const error = vi.fn();
      ctrl.subscribe({ next: () => {}, error });
      expect(error).not.toHaveBeenCalled();
    });
  });
});
