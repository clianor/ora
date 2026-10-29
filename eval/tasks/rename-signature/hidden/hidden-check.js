const assert = require('node:assert');
const price = require('./price.js');
const { cartTotal } = require('./cart.js');

assert.strictEqual(price.calc, undefined);
assert.strictEqual(price.applyDiscount({ price: 200, rate: 0.25 }), 150);
assert.strictEqual(cartTotal([{ price: 80 }, { price: 20 }], 0.5), 50);
assert.strictEqual(cartTotal([], 0.5), 0);
console.log('ok');
