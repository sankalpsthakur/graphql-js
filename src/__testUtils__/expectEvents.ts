import { expect } from 'chai';

import type { MinimalTracingChannel } from '../diagnostics.ts';

import type {
  TestTracingChannel,
  TracingSubChannel,
  TracingSubChannelRecord,
} from './diagnosticsTracing.ts';
import { tracingSubChannels } from './diagnosticsTracing.ts';

export type CollectedEvent = {
  [Channel in TracingSubChannel]: {
    channel: Channel;
    context: Parameters<MinimalTracingChannel[Channel]['publish']>[0];
  };
}[TracingSubChannel];

export type CollectedEventFor<TContext = unknown> = {
  [Channel in TracingSubChannel]: {
    channel: Channel;
    context: TContext;
  };
}[TracingSubChannel];

type ExpectedEventsFactory<TResult, TContext = unknown> = (
  result: Awaited<TResult>,
) => ReadonlyArray<CollectedEventFor<TContext>>;

/**
 * Copy enumerable clone-safe fields plus hidden GraphQL.js objects so tests
 * can still assert on `schema` / `document` / `result` after those properties
 * are made non-enumerable for structured clone.
 */
export function snapshotTracingContext<TContext>(context: TContext): TContext {
  if (typeof context !== 'object' || context === null) {
    return context;
  }
  const snapshot: { [key: string]: unknown } = {
    ...(context as { [key: string]: unknown }),
  };
  for (const key of Object.getOwnPropertyNames(context)) {
    if (Object.hasOwn(snapshot, key)) {
      continue;
    }
    const value = (context as { [key: string]: unknown })[key];
    if (value === undefined && (key === 'result' || key === 'error')) {
      continue;
    }
    snapshot[key] = value;
  }
  return snapshot as TContext;
}

/**
 * Collect GraphQL tracing events while `fn` runs, build the expected event
 * list from the callback result, and always unsubscribe before returning.
 */
export async function expectEvents<TContext = unknown, TResult = unknown>(
  channel: TestTracingChannel<TContext>,
  fn: () => TResult,
  getExpectedEvents: ExpectedEventsFactory<TResult, TContext>,
): Promise<void> {
  const events: Array<CollectedEventFor<TContext>> = [];
  const handler = {} as TracingSubChannelRecord<(context: TContext) => void>;

  for (const tracingSubChannel of tracingSubChannels) {
    handler[tracingSubChannel] = (context: TContext) => {
      const snapshot = snapshotTracingContext(context);
      events.push({
        channel: tracingSubChannel,
        context: snapshot,
      });
    };
  }

  channel.subscribe(handler);

  try {
    const resolvedResult = await fn();
    expect(events).to.deep.equal(getExpectedEvents(resolvedResult));
  } finally {
    channel.unsubscribe(handler);
  }
}
