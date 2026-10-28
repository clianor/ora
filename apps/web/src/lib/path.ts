/** 작업 폴더 경로에서 폴더 이름만 돌려줍니다. 전체 경로는 툴팁과 스크린리더용으로 따로 둡니다. */
export function basename(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.at(-1) ?? path;
}
