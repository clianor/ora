const assert = require('node:assert');
const { average } = require('./average.js');

assert.strictEqual(average([2, 4, 6]), 4);
console.log('ok');
