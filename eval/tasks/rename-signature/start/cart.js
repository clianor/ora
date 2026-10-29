const { calc } = require('./price.js');

function cartTotal(items, rate) {
  return items.reduce((sum, item) => sum + calc(item.price, rate), 0);
}

module.exports = { cartTotal };
