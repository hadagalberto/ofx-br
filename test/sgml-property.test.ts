/**
 * Property-based tests: the lenient pipeline must be total — arbitrary
 * strings, arbitrary 16-bit code-unit sequences (lone surrogates included)
 * and arbitrary bytes can never make it throw. Round-trip: any document
 * generated from a random tree serializes, parses back to the same tree,
 * and produces zero warnings.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeOfx, parseOfxHeader, parseSgml } from '../src/index.js';
import type { SgmlElement } from '../src/index.js';

describe('lenient parsing is total (property tests)', () => {
  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (text) => {
        expect(() => parseSgml(text)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary 16-bit code-unit strings (lone surrogates included)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 300 }), (codes) => {
        const text = String.fromCharCode(...codes);
        expect(() => parseSgml(text)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary bytes through decode → header → tree', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 2048 }), (bytes) => {
        expect(() => {
          const decoded = decodeOfx(bytes);
          const header = parseOfxHeader(decoded.text);
          parseSgml(decoded.text, {
            startOffset: header.endOffset,
            flavor: header.version === '2' ? 'xml' : 'sgml',
          });
        }).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on truncated fragments of a real body', () => {
    const body = [
      '<OFX><SIGNONMSGSRSV1><SONRS><CODE>0<SEVERITY>INFO',
      '<BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240101[-3:BRT]<TRNAMT>-12.34&',
      '<FITID>1<MEMO>Pix enviado — LANCHES & CIA &#38; ME',
      '</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\r\n');
    fc.assert(
      fc.property(fc.integer({ min: 0, max: body.length }), (cut) => {
        expect(() => parseSgml(body.slice(0, cut))).not.toThrow();
      }),
      { numRuns: 400 },
    );
  });
});

/** Random-tree → serialize → parse → same tree, zero warnings. */
describe('well-formed documents round-trip (property tests)', () => {
  const NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  // OFX never nests same-name elements, so generated names get a distinct
  // leading letter per depth: ancestors can never share a name with a
  // descendant (siblings may share, which real files do too).
  const DEPTH_LETTERS = ['A', 'B', 'C', 'D'];

  function nameArb(depth: number) {
    return fc
      .tuple(
        fc.constant(DEPTH_LETTERS[depth] ?? 'A'),
        fc.string({ unit: fc.constantFrom(...NAME_CHARS), minLength: 0, maxLength: 5 }),
      )
      .map(([letter, rest]) => letter + rest);
  }

  // Interior may be anything printable-ish (including '&' and '<', which the
  // serializer escapes); the edges are non-whitespace so no trimming occurs.
  const midTextArb = fc.string({
    unit: fc.constantFrom('a', 'b', '1', 'ç', ' ', '\t', '\n', '\r', '&', '<', '>', '"', "'"),
    maxLength: 12,
  });
  const textArb = fc
    .tuple(fc.constantFrom('x', '1', 'Q'), midTextArb, fc.constantFrom('y', '9', 'Z'))
    .map(([head, mid, tail]) => head + mid + tail);

  interface GenTree {
    readonly name: string;
    readonly text: string;
    readonly children: GenTree[];
  }

  function leafArb(depth: number): fc.Arbitrary<GenTree> {
    return fc
      .record({ name: nameArb(depth), text: textArb })
      .map((r) => ({ name: r.name, text: r.text, children: [] }));
  }

  function treeArb(depth: number, maxDepth: number): fc.Arbitrary<GenTree> {
    if (depth === maxDepth) {
      return leafArb(depth);
    }
    return fc.oneof(
      leafArb(depth),
      fc
        .record({
          name: nameArb(depth),
          children: fc.array(treeArb(depth + 1, maxDepth), { maxLength: 3 }),
        })
        .map((r) => ({ name: r.name, text: '', children: r.children })),
    );
  }

  const docArb = fc.array(treeArb(0, 2), { minLength: 1, maxLength: 3 });

  function escapeText(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  }

  function serializeTree(tree: GenTree): string {
    if (tree.children.length === 0) {
      return `<${tree.name}>${escapeText(tree.text)}</${tree.name}>`;
    }
    return `<${tree.name}>${tree.children.map(serializeTree).join('')}</${tree.name}>`;
  }

  function expectedShape(tree: GenTree): Record<string, unknown> {
    // Leaves always carry non-empty text; aggregates never do (a zero-child
    // aggregate serializes as `<N></N>` and parses back without a text key).
    if (tree.text !== '') {
      return { name: tree.name, children: [], text: tree.text };
    }
    return { name: tree.name, children: tree.children.map(expectedShape) };
  }

  function actualShape(element: SgmlElement): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: element.name,
      children: element.children.map(actualShape),
    };
    if (element.text !== undefined) {
      out.text = element.text;
    }
    return out;
  }

  it('parses a serialized random tree back to the identical tree, with no warnings', () => {
    fc.assert(
      fc.property(docArb, (trees) => {
        const doc = trees.map(serializeTree).join('');
        const result = parseSgml(doc);
        expect(result.warnings).toEqual([]);
        expect(actualShape(result.root)).toEqual({
          name: '#document',
          children: trees.map(expectedShape),
        });
      }),
      { numRuns: 150 },
    );
  });

  it('round-trips in strict mode too: well-formed input never throws', () => {
    fc.assert(
      fc.property(docArb, (trees) => {
        const doc = trees.map(serializeTree).join('');
        expect(() => parseSgml(doc, { strict: true })).not.toThrow();
      }),
      { numRuns: 150 },
    );
  });
});
