/* eslint-disable n/no-unsupported-features/node-builtins */
import dc from 'node:diagnostics_channel';
import { describe, it } from 'node:test';

import { expect } from 'chai';

import { invariant } from '../jsutils/invariant.ts';

import { parse } from '../language/parser.ts';

import { execute } from '../execution/execute.ts';

import { buildSchema } from '../utilities/buildASTSchema.ts';

import type { GraphQLParseContext } from '../diagnostics.ts';
import {
  parseChannel,
  prepareTracingContext,
  traceMixed,
} from '../diagnostics.ts';

describe('tracing raw error clone isolation', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['Error', new Error('failure')],
    ['function', () => undefined],
    ['symbol', Symbol('failure')],
    ['object', { callback: () => undefined }],
    [
      'Error with non-cloneable cause',
      new Error('failure', { cause: () => undefined }),
    ],
    ['string', 'failure'],
    ['null', null],
    ['undefined', undefined],
  ];

  for (const [label, thrown] of cases) {
    for (const mode of ['native', 'mixed throw', 'mixed rejection']) {
      it(`${mode} preserves ${label} locally without cloning it`, async () => {
        invariant(parseChannel !== undefined);
        const realChannel =
          dc.tracingChannel<GraphQLParseContext>('graphql:parse');
        const clones: Array<unknown> = [];
        const cloneFailures: Array<unknown> = [];
        const errors: Array<unknown> = [];
        const events: Array<string> = [];
        function capture(event: string, context: GraphQLParseContext): void {
          events.push(event);
          if (event === 'error') {
            errors.push(context.error);
          }
          try {
            clones.push(structuredClone(context));
          } catch (error) {
            cloneFailures.push(error);
          }
        }
        const handlers = {
          start: (context: GraphQLParseContext) => capture('start', context),
          end: (context: GraphQLParseContext) => capture('end', context),
          asyncStart: (context: GraphQLParseContext) =>
            capture('asyncStart', context),
          asyncEnd: (context: GraphQLParseContext) =>
            capture('asyncEnd', context),
          error: (context: GraphQLParseContext) => capture('error', context),
        };
        realChannel.subscribe(handlers);
        let caught = false;
        try {
          const context = { source: '{ value }' };
          const fail = () => {
            throw thrown;
          };
          try {
            if (mode === 'native') {
              parseChannel.traceSync(fail, context);
            } else if (mode === 'mixed throw') {
              traceMixed(parseChannel, context, fail);
            } else {
              await traceMixed(parseChannel, context, () =>
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise arbitrary rejection values
                Promise.reject(thrown),
              );
            }
          } catch (error) {
            caught = true;
            expect(error).to.equal(thrown);
          }
        } finally {
          realChannel.unsubscribe(handlers);
        }
        expect(caught).to.equal(true);
        expect(errors).to.have.lengthOf(1);
        expect(errors[0]).to.equal(thrown);
        expect(events).to.deep.equal(
          mode === 'mixed rejection'
            ? ['start', 'end', 'error', 'asyncStart', 'asyncEnd']
            : ['start', 'error', 'end'],
        );
        expect(cloneFailures).to.deep.equal([]);
        expect(clones).to.have.lengthOf(events.length);
        for (const clone of clones) {
          expect(clone).to.deep.equal({ source: '{ value }' });
        }
      });
    }

    for (const asynchronous of [false, true]) {
      it(`public resolver ${asynchronous ? 'rejection' : 'throw'} retains ${label}`, async () => {
        const errors: Array<unknown> = [];
        const clones: Array<unknown> = [];
        const cloneFailures: Array<unknown> = [];
        const channel = dc.tracingChannel('graphql:resolve');
        const handler = (context: unknown) => {
          errors.push((context as { error?: unknown }).error);
          try {
            clones.push(structuredClone(context));
          } catch (error) {
            cloneFailures.push(error);
          }
        };
        channel.error.subscribe(handler);
        try {
          const result = await execute({
            schema: buildSchema('type Query { value: String }'),
            document: parse('{ value }'),
            rootValue: {
              value() {
                if (asynchronous) {
                  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise arbitrary rejection values
                  return Promise.reject(thrown);
                }
                throw thrown;
              },
            },
          });
          expect(result.errors).to.have.lengthOf(1);
        } finally {
          channel.error.unsubscribe(handler);
        }
        expect(errors).to.have.lengthOf(1);
        expect(errors[0]).to.equal(thrown);
        expect(cloneFailures).to.deep.equal([]);
        expect(clones).to.have.lengthOf(1);
        expect(clones[0]).to.not.have.property('error');
      });
    }
  }

  it('preserves an existing raw error while hiding the property', () => {
    const error = Symbol('existing');
    const context = prepareTracingContext({ error, source: 'query' });
    expect(context.error).to.equal(error);
    expect(structuredClone(context)).to.deep.equal({ source: 'query' });
    context.error = Symbol('replacement');
    expect(structuredClone(context)).to.deep.equal({ source: 'query' });
  });
});
