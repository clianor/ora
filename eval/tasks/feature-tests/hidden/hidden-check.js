const assert = require('node:assert');
const { existsSync } = require('node:fs');
// 지시문은 내보내기 형태를 정하지 않았으므로, 함수 자체를 내보낸 경우와 { slugify }로 내보낸 경우를 모두 받는다.
const exported = require('./slug.js');
const slugify = typeof exported === 'function' ? exported : exported.slugify;

assert.strictEqual(slugify('Hello World'), 'hello-world');
assert.strictEqual(slugify('  --A  b--  '), 'a-b');
assert.strictEqual(slugify(''), '');
assert.strictEqual(slugify('!!!'), '');
assert.strictEqual(slugify('a___b'), 'a-b');
assert.strictEqual(slugify('Node22'), 'node22');
assert.ok(existsSync('./slug.test.js'), 'slug.test.js가 없습니다.');
console.log('ok');
