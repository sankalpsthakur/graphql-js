/* eslint-disable n/no-unsupported-features/node-builtins */
import dc from 'node:diagnostics_channel';
import { describe, it } from 'node:test';

import { expect } from 'chai';

import { invariant } from '../jsutils/invariant.ts';

import { parse } from '../language/parser.ts';
import { Source } from '../language/source.ts';

import { validate } from '../validation/validate.ts';

import { execute } from '../execution/execute.ts';

import { buildSchema } from '../utilities/buildASTSchema.ts';

import type { MinimalChannel, MinimalTracingChannel } from '../diagnostics.ts';
import {
  executeChannel,
  executeRootSelectionSetChannel,
  executeVariableCoercionChannel,
  parseChannel,
  prepareTracingContext,
  resolveChannel,
  shouldTrace,
  subscribeChannel,
  validateChannel,
} from '../diagnostics.ts';

describe('diagnostics', () => {
  it('auto-registers the GraphQL tracing channels', () => {
    invariant(parseChannel !== undefined);
    invariant(validateChannel !== undefined);
    invariant(executeChannel !== undefined);
    invariant(executeVariableCoercionChannel !== undefined);
    invariant(executeRootSelectionSetChannel !== undefined);
    invariant(subscribeChannel !== undefined);
    invariant(resolveChannel !== undefined);

    // Node.js `tracingChannel(name)` returns a fresh wrapper per call but
    // the underlying sub-channels are cached by name, so compare those.
    expect(parseChannel.start).to.equal(
      dc.channel('tracing:graphql:parse:start'),
    );
    expect(validateChannel.start).to.equal(
      dc.channel('tracing:graphql:validate:start'),
    );
    expect(executeChannel.start).to.equal(
      dc.channel('tracing:graphql:execute:start'),
    );
    expect(executeVariableCoercionChannel.start).to.equal(
      dc.channel('tracing:graphql:execute:variableCoercion:start'),
    );
    expect(executeRootSelectionSetChannel.start).to.equal(
      dc.channel('tracing:graphql:execute:rootSelectionSet:start'),
    );
    expect(subscribeChannel.start).to.equal(
      dc.channel('tracing:graphql:subscribe:start'),
    );
    expect(resolveChannel.start).to.equal(
      dc.channel('tracing:graphql:resolve:start'),
    );
  });

  describe('shouldTrace', () => {
    function makeSubChannel(hasSubscribers: boolean): MinimalChannel {
      return {
        hasSubscribers,
        publish: () => undefined,
        runStores<T, ContextType extends object>(
          context: ContextType,
          fn: (this: ContextType, ...args: Array<unknown>) => T,
        ): T {
          return fn.call(context);
        },
      };
    }

    function makeFallbackTracingChannel(
      subscribedSubChannel?: keyof Pick<
        MinimalTracingChannel,
        'start' | 'end' | 'asyncStart' | 'asyncEnd' | 'error'
      >,
    ): MinimalTracingChannel {
      return {
        hasSubscribers: undefined,
        start: makeSubChannel(subscribedSubChannel === 'start'),
        end: makeSubChannel(subscribedSubChannel === 'end'),
        asyncStart: makeSubChannel(subscribedSubChannel === 'asyncStart'),
        asyncEnd: makeSubChannel(subscribedSubChannel === 'asyncEnd'),
        error: makeSubChannel(subscribedSubChannel === 'error'),
        traceSync<T>(fn: (...args: Array<unknown>) => T): T {
          return fn();
        },
      };
    }

    it('returns false when channel is undefined', () => {
      expect(shouldTrace(undefined)).to.equal(false);
    });

    it('reflects the aggregate hasSubscribers on a real tracing channel', () => {
      const tc = dc.tracingChannel(
        'shouldTrace:aggregate',
      ) as unknown as MinimalTracingChannel;
      expect(shouldTrace(tc)).to.equal(false);

      const handler = {
        start: () => undefined,
        end: () => undefined,
        asyncStart: () => undefined,
        asyncEnd: () => undefined,
        error: () => undefined,
      };
      const realTC = dc.tracingChannel('shouldTrace:aggregate');
      realTC.subscribe(handler);
      try {
        expect(shouldTrace(tc)).to.equal(true);
      } finally {
        realTC.unsubscribe(handler);
      }
    });

    it('falls back to sub-channel subscribers when aggregate is missing', () => {
      expect(shouldTrace(makeFallbackTracingChannel('error'))).to.equal(true);
      expect(shouldTrace(makeFallbackTracingChannel())).to.equal(false);
    });
  });

  describe('prepareTracingContext', () => {
    it('hides non-cloneable fields while keeping them readable', () => {
      const schema = { name: 'S' };
      const document = { kind: 'Document' };
      const operation = { kind: 'OperationDefinition' };
      const args = { fn: () => undefined };
      const rawVariableValues = { fn: () => undefined };
      const result = { fn: () => undefined };
      const context = prepareTracingContext({
        schema,
        document,
        operation,
        args,
        rawVariableValues,
        operationName: 'Q',
        fieldPath: 'user.name',
        result: undefined as typeof result | undefined,
      });

      expect(context.schema).to.equal(schema);
      expect(context.document).to.equal(document);
      expect(context.operation).to.equal(operation);
      expect(context.args).to.equal(args);
      expect(context.rawVariableValues).to.equal(rawVariableValues);
      expect(Object.keys(context).sort()).to.deep.equal([
        'fieldPath',
        'operationName',
      ]);

      expect(structuredClone(context)).to.deep.equal({
        fieldPath: 'user.name',
        operationName: 'Q',
      });

      context.result = result;
      expect(context.result).to.equal(result);
      expect(structuredClone(context)).to.deep.equal({
        fieldPath: 'user.name',
        operationName: 'Q',
      });
    });

    it('leaves missing keys alone', () => {
      const context = prepareTracingContext({ operationName: 'Q' });
      expect(Object.hasOwn(context, 'schema')).to.equal(false);
      expect(structuredClone(context)).to.deep.equal({ operationName: 'Q' });
    });
  });

  describe('structured-clone-safe payloads', () => {
    const schema = buildSchema(`
      type Query {
        sync: String
        nested: Nested
      }
      type Nested {
        leaf: String
      }
    `);

    function noopHandler() {
      return {
        start: () => undefined,
        end: () => undefined,
        asyncStart: () => undefined,
        asyncEnd: () => undefined,
        error: () => undefined,
      };
    }

    it('clone-safely publishes parse, validate, execute, and resolve', () => {
      const published: Array<object> = [];
      const capture = {
        start: (context: object) => published.push(context),
        end: (context: object) => published.push(context),
        asyncStart: (context: object) => published.push(context),
        asyncEnd: (context: object) => published.push(context),
        error: (context: object) => published.push(context),
      };
      const channels = [
        dc.tracingChannel('graphql:parse'),
        dc.tracingChannel('graphql:validate'),
        dc.tracingChannel('graphql:execute'),
        dc.tracingChannel('graphql:resolve'),
      ];

      for (const channel of channels) {
        channel.subscribe(capture);
      }
      try {
        const source = new Source('{ nested { leaf } }');
        const document = parse(source);
        validate(schema, document);
        execute({
          schema,
          document,
          rootValue: {
            nested: {
              leaf: 'ok',
              helper() {
                return 'not cloneable if enumerable';
              },
            },
          },
        });
      } finally {
        for (const channel of channels) {
          channel.unsubscribe(capture);
        }
      }

      expect(published.length).to.be.greaterThan(0);
      for (const context of published) {
        expect(() => structuredClone(context)).to.not.throw();
      }
    });

    it('keeps schema and Source readable on the live context', () => {
      let parseContext: { source?: Source } | undefined;
      let executeContext: { schema?: unknown } | undefined;
      const parseHandler = {
        ...noopHandler(),
        start: (context: { source?: Source }) => {
          parseContext = context;
        },
      };
      const executeHandler = {
        ...noopHandler(),
        start: (context: { schema?: unknown }) => {
          executeContext = context;
        },
      };
      const parseTC = dc.tracingChannel('graphql:parse');
      const executeTC = dc.tracingChannel('graphql:execute');

      parseTC.subscribe(parseHandler);
      executeTC.subscribe(executeHandler);
      try {
        const source = new Source('{ sync }');
        const document = parse(source);
        execute({
          schema,
          document,
          rootValue: { sync: 'hello' },
        });
        expect(parseContext?.source).to.equal(source);
        expect(executeContext?.schema).to.equal(schema);
      } finally {
        parseTC.unsubscribe(parseHandler);
        executeTC.unsubscribe(executeHandler);
      }
    });
  });
});
