import { stderr, stdin, stdout } from 'node:process';
import { hashPassword } from './password.js';

// Local helper: prints the Argon2id hash for STUDIO_OPERATOR_PASSWORD_HASH.
//   pnpm --filter @agentic-studio/api run auth:hash-password
// The password is read from stdin (hidden when typed in a terminal), never from
// argv, so it stays out of shell history and process listings. Only the hash is printed.

const MIN_LENGTH = 12;

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

function readHidden(prompt: string): Promise<string> {
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u0003' || char === '\u0004') {
          finish();
          reject(new Error('Cancelled.'));
          return;
        }
        value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  if (!stdin.isTTY) {
    return readPiped();
  }
  const password = await readHidden('Operator password (hidden): ');
  const confirmation = await readHidden('Repeat the password: ');
  if (password !== confirmation) {
    throw new Error('The passwords do not match.');
  }
  return password;
}

try {
  const password = await readPassword();
  if (password.length < MIN_LENGTH) {
    throw new Error(`Use a strong password of at least ${MIN_LENGTH} characters.`);
  }
  stdout.write(`${await hashPassword(password)}\n`);
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : 'Failed.'}\n`);
  process.exitCode = 1;
}
