const { readFileSync, existsSync } = require('node:fs');
const { resolve, dirname, join, isAbsolute } = require('node:path');

function findConfig(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.pintu.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadConfig(startDir) {
  const path = findConfig(startDir);
  if (!path) return { config: {}, path: null, rootDir: resolve(startDir) };
  const raw = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${e.message}`);
  }
  return { config: parsed, path, rootDir: dirname(path) };
}

function resolveRelative(baseDir, p) {
  if (!p) return null;
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

module.exports = { loadConfig, resolveRelative };
