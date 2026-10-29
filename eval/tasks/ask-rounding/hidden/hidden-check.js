const assert = require('node:assert');
const { formatPrice } = require('./money.js');

assert.strictEqual(formatPrice(1.001), '1.01');
assert.strictEqual(formatPrice(2), '2.00');
assert.strictEqual(formatPrice(3.141), '3.15');
console.log('ok');
