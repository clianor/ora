import { execFileSync } from 'node:child_process';

const prodAllowed = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'];
// 사용자가 결정한 개발 도구 전용 예외다.
const devAllowed = [...prodAllowed, 'BlueOak-1.0.0', 'MPL-2.0'];

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

const violations = Object.entries(readLicenses(['licenses', 'list', '--json'])).flatMap(
  ([license, packages]) =>
    packages
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
