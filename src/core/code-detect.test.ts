import { describe, expect, it } from 'vitest';
import { looksLikeCode } from './code-detect';

describe('prose in a <pre> is not code', () => {
  it('recognises an output specification', () => {
    // The nowcoder block that prompted this: a spec, set in <pre>, all prose.
    expect(
      looksLikeCode(`Output the answer for each test case in order.

If no valid construction exists, output a single line containing the integer -1.

Otherwise, first output a line containing two integers n and m, the number of
vertices and edges in the constructed graph, respectively. Then output m lines,
each containing two integers u, v, representing an undirected edge connecting
vertices u and v.

The output graph must be simple: no self-loops and no multiple edges are
allowed. The order of the edges in the output is arbitrary.

If there are multiple valid constructions, output any of them.`),
    ).toBe(false);
  });

  it('recognises an input specification', () => {
    expect(
      looksLikeCode(`The first line contains an integer t, the number of test cases.

Each of the next t lines contains one integer k.`),
    ).toBe(false);
  });

  it('recognises pseudocode written in English', () => {
    expect(
      looksLikeCode(`dp():
    Let q be an empty queue
    Initialize id[1..n] to n+1
    Push 1 into q

    While q is not empty:
        Pop the front element of q into u
        Enumerate all neighbors v of u in increasing order:
            If id[v] is greater than id[u]:
                Push v into q

    Return counter`),
    ).toBe(false);
  });
});

describe('real source code is code', () => {
  it('recognises C++', () => {
    expect(
      looksLikeCode(`#include <iostream>
#include <vector>
using namespace std;

void solve() {
    long long k;
    cin >> k;
    if (k % 2 != 0 && k < 17) {
        cout << -1 << "\\n";
        return;
    }
}`),
    ).toBe(true);
  });

  it('recognises Python', () => {
    expect(
      looksLikeCode(`import sys

def solve(n, edges):
    seen = set()
    for u, v in edges:
        seen.add((u, v))
    return len(seen)`),
    ).toBe(true);
  });

  it('recognises JavaScript', () => {
    expect(
      looksLikeCode(`const fs = require('fs');

function main() {
    const data = fs.readFileSync(0, 'utf8');
    return data.split('\\n').map(Number);
}`),
    ).toBe(true);
  });

  it('recognises a shell session', () => {
    expect(looksLikeCode('$ npm install\n$ npm run build')).toBe(true);
  });

  it('treats a lone line as code unless clearly a sentence', () => {
    expect(looksLikeCode('npm install')).toBe(true);
    expect(looksLikeCode('int x = 0;')).toBe(true);
    expect(looksLikeCode('This line is an ordinary English sentence.')).toBe(false);
  });

  it('treats sample input and output data as code', () => {
    // Test data must never be translated.
    expect(looksLikeCode('3\n1 2\n2 3\n1 3')).toBe(true);
    expect(looksLikeCode('')).toBe(true);
  });
});
