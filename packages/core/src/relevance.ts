const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;

/** 영문·숫자는 단어로, 한글은 단어와 글자 두 개씩 묶은 조각으로 나눈다. 조사가 붙은 한국어 단어도 어간이 겹치면 맞는다. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    tokens.push(word);
    if (!HANGUL.test(word)) continue;
    for (let index = 0; index + 2 <= word.length; index += 1)
      tokens.push(word.slice(index, index + 2));
  }
  return tokens;
}

const K1 = 1.2;
const B = 0.75;

/** 질의와 문서 각각의 BM25 점수다. 순서는 `documents`와 같고, 질의와 겹치는 낱말이 없으면 0이다. */
export function scoreBm25(query: string, documents: readonly string[]): number[] {
  const docs = documents.map(tokenize);
  const average = docs.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(docs.length, 1);
  const queryTerms = new Set(tokenize(query));
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(term, docs.filter((tokens) => tokens.includes(term)).length);
  }
  return docs.map((tokens) => {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = tokens.filter((token) => token === term).length;
      if (frequency === 0) continue;
      const containing = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5));
      score +=
        (idf * frequency * (K1 + 1)) /
        (frequency + K1 * (1 - B + (B * tokens.length) / Math.max(average, 1)));
    }
    return score;
  });
}
