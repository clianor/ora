// 숫자 배열의 평균을 돌려준다. 빈 배열이면 0이다.
function average(numbers) {
  if (numbers.length === 0) return 0;
  let total = 0;
  for (let i = 1; i < numbers.length; i += 1) total += numbers[i];
  return total / numbers.length;
}

module.exports = { average };
