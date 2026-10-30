import { execFileSync } from 'node:child_process';

const prodAllowed = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'];
// 사용자가 결정한 개발 도구 전용 예외다. CC-BY-4.0은 사용자 결정, caniuse-lite 데이터, 개발 전용이다.
const devAllowed = [...prodAllowed, 'BlueOak-1.0.0', 'MPL-2.0', 'CC-BY-4.0'];

// 글꼴 패키지 두 개에만 허용하는 예외다. OFL-1.1을 일반 허용 목록에 넣지 않는다.
const fontPackages = new Set(['pretendard', '@fontsource/jetbrains-mono']);

// electron-builder(개발 도구, 사용자 승인)의 의존 트리에만 있는 패키지다. 배포물에 들어가지 않는다.
// ponytail: 이름으로만 거른다. 같은 이름의 다른 버전이 배포 의존성에 들어와도 걸리지 않으므로, 라이선스를 바꾸는 업데이트가 오면 이 목록을 다시 본다.
const builderPackages = new Set(['argparse', 'isexe', 'truncate-utf8-bytes']);

interface LicensedPackage {
  name: string;
  versions: string[];
}

type LicenseReport = Record<string, LicensedPackage[]>;

function readLicenses(args: string[]): LicenseReport {
  const output = execFileSync('pnpm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(output) as LicenseReport;
}

function isAllowed(expression: string, allowed: string[]): boolean {
  return expression
    .replace(/[()]/g, '')
    .split(' OR ')
    .some((alternative) =>
      alternative.split(' AND ').every((license) => allowed.includes(license.trim())),
    );
}

const prodPackages = new Set(
  Object.values(readLicenses(['-r', 'licenses', 'list', '--prod', '--json']))
    .flat()
    .map((pkg) => pkg.name),
);

const violations = Object.entries(readLicenses(['-r', 'licenses', 'list', '--json'])).flatMap(
  ([license, packages]) =>
    packages
      .filter((pkg) => !(license === 'OFL-1.1' && fontPackages.has(pkg.name)))
      .filter((pkg) => !builderPackages.has(pkg.name))
      .filter((pkg) => !isAllowed(license, prodPackages.has(pkg.name) ? prodAllowed : devAllowed))
      .map((pkg) => `${pkg.name}@${pkg.versions.join(',')} (${license})`),
);

if (violations.length > 0) {
  console.error('허용 목록 밖의 라이선스를 찾았습니다.');
  console.error(`배포 의존성 허용: ${prodAllowed.join(', ')}`);
  console.error(`개발 도구 허용: ${devAllowed.join(', ')}`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
