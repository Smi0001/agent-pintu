const { writeFileSync, existsSync } = require('node:fs');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const readline = require('node:readline');

const TEMPLATE = {
  project: '.',
  serverRoot: 'server',
  tsConfig: 'server/tsconfig.json',
  appEntry: 'server/app.ts',
  baseBranch: 'main',
  outDir: 'documents/pr-traces',
  routesPattern: '/routes/',
  depth: 4,
};

function ask(question) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      res(answer);
    });
  });
}

async function runInit() {
  const path = join(process.cwd(), '.pintu.json');
  if (existsSync(path)) {
    const ans = await ask(`${path} already exists. Overwrite? [y/N] `);
    if (!/^y(es)?$/i.test(ans.trim())) {
      console.log('Aborted.');
      return;
    }
  }
  writeFileSync(path, JSON.stringify(TEMPLATE, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${path}.`);
  console.log('Edit the paths to match your project layout, then run:');
  console.log('  agent-pintu trace --pr-num <n> --title "..."');
}

module.exports = { runInit };
