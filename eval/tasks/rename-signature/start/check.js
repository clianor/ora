const assert = require('node:assert');
const { cartTotal } = require('./cart.js');

assert.strictEqual(cartTotal([{ price: 100 }, { price: 50 }], 0.1), 135);
console.log('ok');
