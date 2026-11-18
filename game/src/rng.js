// A tiny seeded generator (mulberry32). Every random choice in the match —
// bot skill, routes, spread — draws from one stream per seed, so a
// ?shot=…&seed=N capture renders the same frame every time.
export function makeRng(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick one item from a list with the seeded stream.
export function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}
