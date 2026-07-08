// PCG32, matching the role of rnd_pcg in CLAVIER's register file:
// a small deterministic PRNG so grid randomness is reproducible from the seed.

const MASK64 = (1n << 64n) - 1n;
const MULT = 6364136223846793005n;

export class PCG {
  constructor(seed = 0x36n) {
    this.state = 0n;
    this.inc = ((BigInt(seed) << 1n) | 1n) & MASK64;
    this.next();
    this.state = (this.state + BigInt(seed)) & MASK64;
    this.next();
  }

  next() {
    const old = this.state;
    this.state = (old * MULT + this.inc) & MASK64;
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n);
    return ((xorshifted >>> rot) | (xorshifted << (-rot & 31))) >>> 0;
  }
}
