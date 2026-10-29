const assert = require('node:assert');
const { bump } = require('./version.js');

assert.strictEqual(bump('1.2.3'), '1.2.4');
assert.strictEqual(bump('0.0.9'), '0.0.10');
assert.strictEqual(bump('2.10.0'), '2.10.1');
console.log('ok');
