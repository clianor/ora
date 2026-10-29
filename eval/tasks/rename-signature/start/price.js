// 가격에서 할인율(0~1)만큼 깎은 값을 돌려준다.
function calc(price, rate) {
  return price - price * rate;
}

module.exports = { calc };
