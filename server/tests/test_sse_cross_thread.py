"""SSE delivery must survive a writer on another thread.

The workflow engine runs in its own thread with its own event loop
(`catgo/workflow/engine/lifecycle.py`), and node results now publish from there.
`asyncio.Queue.put_nowait` called from a foreign thread completes a Future that
belongs to the consumer's loop — asyncio forbids this, and the practical symptom
is an SSE consumer that never wakes: the event is enqueued but the `await
q.get()` sitting in the /view/subscribe generator is not scheduled.

These tests exercise the real shape: a consumer awaiting on loop A, a writer
calling `_notify` from thread B.
"""

import asyncio
import threading
from time import perf_counter

import pytest

from catgo.routers import view_state


def setup_function():
    view_state.reset()


def teardown_function():
    view_state.reset()


def test_an_event_written_from_another_thread_wakes_a_waiting_consumer():
    async def scenario():
        q = view_state.subscribe("structure-1")
        view_state.mark_active("structure-1")

        done = threading.Event()

        def engine_thread():
            # a real second loop, like the workflow engine's
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                view_state.notify_result("structure-1", "node", {"task_id": "t-1"})
            finally:
                loop.close()
                done.set()

        threading.Thread(target=engine_thread, daemon=True).start()

        # The consumer is ASLEEP in q.get() — this is the part put_nowait from a
        # foreign thread cannot wake. NB the assertion is on LATENCY, not just
        # arrival: without the fix the item lands in the deque immediately but
        # the consumer is not scheduled, so it surfaces only when the loop wakes
        # for some other reason (here the wait_for timer; in production the 15 s
        # SSE heartbeat). A delivery test alone passes either way and proves
        # nothing.
        started = perf_counter()
        msg = await asyncio.wait_for(q.get(), timeout=5)
        elapsed = perf_counter() - started
        assert done.wait(timeout=5)
        assert msg["event"] == "result"
        assert msg["data"]["task_id"] == "t-1"
        assert elapsed < 0.5, f"woken only after {elapsed:.2f}s — not scheduled by the writer"

    asyncio.run(scenario())


def test_a_writer_with_no_loop_at_all_still_delivers():
    # Plain synchronous callers (CLI, a sync FastAPI endpoint in the threadpool)
    # have no running loop; they must not be worse off than before.
    async def scenario():
        q = view_state.subscribe("default")
        view_state.mark_active("default")

        t = threading.Thread(
            target=lambda: view_state.notify_result("default", "node", {"task_id": "t-2"}),
            daemon=True,
        )
        t.start()
        started = perf_counter()
        msg = await asyncio.wait_for(q.get(), timeout=5)
        elapsed = perf_counter() - started
        t.join(timeout=5)
        assert msg["data"]["task_id"] == "t-2"
        assert elapsed < 0.5, f"woken only after {elapsed:.2f}s"

    asyncio.run(scenario())


def test_same_loop_delivery_is_unchanged():
    async def scenario():
        q = view_state.subscribe("default")
        view_state.mark_active("default")
        view_state.notify_result("default", "node", {"task_id": "t-3"})
        msg = await asyncio.wait_for(q.get(), timeout=5)
        assert msg["data"]["task_id"] == "t-3"

    asyncio.run(scenario())


def test_a_full_queue_still_drops_rather_than_blocking_the_writer():
    # The bound is what protects the producer from a stalled consumer; routing
    # through the owning loop must not turn a drop into unbounded growth.
    async def scenario():
        q = view_state.subscribe("default")
        view_state.mark_active("default")
        for _ in range(q.maxsize):
            q.put_nowait({"event": "filler", "data": {}})

        t = threading.Thread(
            target=lambda: view_state.notify_result("default", "node", {"task_id": "t-4"}),
            daemon=True,
        )
        t.start()
        t.join(timeout=5)
        await asyncio.sleep(0.05)  # let the cross-thread callback run
        assert q.qsize() == q.maxsize

    asyncio.run(scenario())


def test_a_closed_consumer_loop_does_not_raise_into_the_producer():
    # A browser tab that went away leaves a queue whose loop is gone. Publishing
    # must not fail the computation that produced the data.
    holder = {}

    async def make_subscriber():
        holder["q"] = view_state.subscribe("default")
        view_state.mark_active("default")

    asyncio.run(make_subscriber())  # the loop is closed when this returns
    owner = view_state.queue_loops.get(holder["q"])
    assert owner is not None and owner.is_closed(), "the dead-loop path is not exercised"

    view_state.notify_result("default", "node", {"task_id": "t-5"})  # must not raise


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
