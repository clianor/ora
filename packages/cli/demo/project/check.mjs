import process from 'node:process';
import { add } from './calc.mjs';

if (add(1, 2) !== 3) {
  process.stderr.write('add(1, 2) failed\n');
  process.exit(1);
}
process.stdout.write('ok\n');
