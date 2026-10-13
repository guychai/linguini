import { mkdir, open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const path = resolve(process.env.OWN_AUTH_FILE ?? '.t3/own/auth.json');
await mkdir(resolve(path, '..'), { recursive: true });
try {
  const file = await open(path, 'wx', 0o600);
  await file.writeFile(JSON.stringify({ [randomBytes(32).toString('hex')]: 'local-owner' }, null, 2) + '\n');
  await file.close();
  console.log('Created local owner bindings. Read the ignored auth file to obtain your UI token.');
} catch (error) { if (error.code !== 'EEXIST') throw error; console.log('Existing owner bindings retained.'); }
