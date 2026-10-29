const assert = require('node:assert');
const { average } = require('./average.js');

assert.strictEqual(average([]), 0);
assert.strictEqual(average([5]), 5);
assert.strictEqual(average([-3, 3, 9]), 3);
assert.strictEqual(average([1, 2]), 1.5);
console.log('ok');
