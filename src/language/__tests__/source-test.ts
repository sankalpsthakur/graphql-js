import { describe, it } from 'node:test';

import { expect } from 'chai';

import { Source } from '../source.ts';

describe('Source', () => {
  it('can be Object.toStringified', () => {
    const source = new Source('');

    expect(Object.prototype.toString.call(source)).to.equal('[object Source]');
  });

  it('rejects invalid locationOffset', () => {
    function createSource(locationOffset: { line: number; column: number }) {
      return new Source('', '', locationOffset);
    }

    expect(() => createSource({ line: 0, column: 1 })).to.throw(
      'line in locationOffset is 1-indexed and must be positive.',
    );
    expect(() => createSource({ line: -1, column: 1 })).to.throw(
      'line in locationOffset is 1-indexed and must be positive.',
    );

    expect(() => createSource({ line: 1, column: 0 })).to.throw(
      'column in locationOffset is 1-indexed and must be positive.',
    );
    expect(() => createSource({ line: 1, column: -1 })).to.throw(
      'column in locationOffset is 1-indexed and must be positive.',
    );
  });

  it('is structured-cloneable without exposing its brand', () => {
    const source = new Source('query Q { field }', 'a.graphql', {
      line: 2,
      column: 3,
    });

    expect(source.__kind).to.be.a('symbol');
    expect(structuredClone(source)).to.deep.equal({
      body: 'query Q { field }',
      name: 'a.graphql',
      locationOffset: { line: 2, column: 3 },
    });
  });
});
