#!/usr/bin/env node
const { parseArgs } = require('../lib/args.js');
const { runTrace } = require('../lib/trace.js');
const { runInit } = require('../lib/init.js');

const HELP = `
agent-pintu — PR call-graph tracer (Mermaid + YAML, via ts-morph)

Usage:
  agent-pintu <command> [options]

Commands:
  init                          Write a .pintu.json template in the current dir
  trace                         Generate a trace for the current branch vs base
  -h, --help                    Show this help

Trace options:
  --mode <routes|touched>       Entry-point strategy (default: prompt if TTY, else "routes")
                                  routes:  walk from changed Express route handlers
                                  touched: walk from every function touched by the diff
  --project <dir>               Project root (default: cwd or nearest .pintu.json dir)
  --base <branch>               Base branch (default: main / master / develop autodetect)
  --pr-num <n>                  PR number for filename (default: "wip")
  --title <text>                Title shown at top of the .md (default: "Trace vs <base>")
  --server-root <dir>           Code root, relative to project (default: "server")
  --ts-config <path>            tsconfig.json path (default: <server-root>/tsconfig.json, optional)
  --app-entry <path>            File where mount-prefix detection looks (routes mode only)
  --routes-pattern <substr>     Substring identifying route files (routes mode only, default: "/routes/")
  --out-dir <dir>               Output directory (default: "documents/pr-traces")
  --depth <n>                   Max call-graph walk depth (default: 4)

Examples:
  agent-pintu init
  agent-pintu trace --pr-num 42 --title "Order Checkout"
  agent-pintu trace --project /path/to/repo --base develop --pr-num 42

Config:
  .pintu.json in the project (or any ancestor dir) provides defaults.
  CLI flags override config. Paths in .pintu.json resolve relative to the
  config file's location.
`.trim();

(async () => {
  const argv = process.argv.slice(2);
  const [first, ...rest] = argv;

  if (!first || first === '-h' || first === '--help' || first === 'help') {
    console.log(HELP);
    return;
  }

  if (first === 'init') {
    await runInit();
    return;
  }

  if (first === 'trace') {
    const args = parseArgs(rest);
    await runTrace(args);
    return;
  }

  console.error(`Unknown command: "${first}"\n`);
  console.error(HELP);
  process.exit(2);
})().catch((err) => {
  console.error(`\nError: ${err?.message || err}`);
  if (process.env.PINTU_DEBUG) console.error(err?.stack);
  process.exit(1);
});
