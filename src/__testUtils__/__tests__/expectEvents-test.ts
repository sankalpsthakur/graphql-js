import { describe, it } from 'node:test';

import { expect } from 'chai';

import { expectEvents, snapshotTracingContext } from '../expectEvents.ts';
import { expectPromise } from '../expectPromise.ts';

type TestTracingChannel = Parameters<typeof expectEvents>[0];

function createFakeTracingChannel(): TestTracingChannel {
  let handler:
    | {
        start: (context: unknown) => void;
        end: (context: unknown) => void;
        asyncStart: (context: unknown) => void;
        asyncEnd: (context: unknown) => void;
        error: (context: unknown) => void;
      }
    | undefined;

  function runStores<T>(
    context: object,
    fn: (this: object, ...args: Array<unknown>) => T,
    thisArg?: unknown,
    ...args: Array<unknown>
  ): T {
    return fn.apply((thisArg as object | undefined) ?? context, args);
  }

  return {
    hasSubscribers: false,
    subscribe(nextHandler) {
      handler = nextHandler;
    },
    unsubscribe(nextHandler) {
      expect(handler).to.equal(nextHandler);
      handler = undefined;
    },
    traceSync(fn, _context, thisArg, ...args) {
      return fn.apply(thisArg, args);
    },
    start: {
      publish(context) {
        handler?.start(context);
      },
      runStores,
    },
    end: {
      publish(context) {
        handler?.end(context);
      },
      runStores,
    },
    asyncStart: {
      publish(context) {
        handler?.asyncStart(context);
      },
      runStores,
    },
    asyncEnd: {
      publish(context) {
        handler?.asyncEnd(context);
      },
      runStores,
    },
    error: {
      publish(context) {
        handler?.error(context);
      },
      runStores,
    },
  };
}

describe('expectEvents', () => {
  it('includes non-enumerable tracing fields and skips unset result', async () => {
    const channel = createFakeTracingChannel();
    const context = Object.defineProperties(
      { value: 1 },
      {
        schema: { value: 'hidden-schema', enumerable: false },
        result: { value: undefined, enumerable: false },
        error: { value: undefined, enumerable: false },
      },
    );

    await expectEvents(
      channel,
      () => {
        channel.start.publish(context);
        return 'done';
      },
      () => [
        {
          channel: 'start',
          context: { value: 1, schema: 'hidden-schema' },
        },
      ],
    );
  });

  it('snapshotTracingContext returns non-objects unchanged', () => {
    expect(snapshotTracingContext(null)).to.equal(null);
    expect(snapshotTracingContext(undefined)).to.equal(undefined);
    expect(snapshotTracingContext('error')).to.equal('error');
  });

  it('collects events and snapshots each published context', async () => {
    const channel = createFakeTracingChannel();
    const context = { value: 1 };

    await expectEvents(
      channel,
      () => {
        channel.start.publish(context);
        context.value = 2;
        channel.end.publish(context);
        return 'done';
      },
      (_result) => [
        {
          channel: 'start',
          context: { value: 1 },
        },
        {
          channel: 'end',
          context: { value: 2 },
        },
      ],
    );
  });

  it('collects events with non-object contexts', async () => {
    const channel = createFakeTracingChannel();

    await expectEvents(
      channel,
      () => {
        channel.start.publish(null);
        channel.end.publish(undefined);
        channel.error.publish('error');
        return 'done';
      },
      (_result) => [
        {
          channel: 'start',
          context: null,
        },
        {
          channel: 'end',
          context: undefined,
        },
        {
          channel: 'error',
          context: 'error',
        },
      ],
    );
  });

  it('unsubscribes when the callback rejects', async () => {
    let activeHandler: object | undefined;
    const error = new Error('boom');
    const channel = createFakeTracingChannel();
    const originalSubscribe = channel.subscribe;
    const originalUnsubscribe = channel.unsubscribe;

    channel.subscribe = (handler) => {
      activeHandler = handler;
      originalSubscribe.call(channel, handler);
    };
    channel.unsubscribe = (handler) => {
      expect(handler).to.equal(activeHandler);
      activeHandler = undefined;
      originalUnsubscribe.call(channel, handler);
    };

    expect(
      await expectPromise(
        expectEvents(
          channel,
          () => Promise.reject(error),
          () => [],
        ),
      ).toReject(),
    ).to.equal(error);
    expect(activeHandler).to.equal(undefined);
  });
});
