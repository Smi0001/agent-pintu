/**
 * PR call-graph extractor — emits Mermaid + YAML artifacts.
 *
 * v0.4: multi-root support. Configure `roots: [...]` in .pintu.json to trace
 * a PR that spans multiple source trees (e.g. server + client + admin).
 * Backward-compatible with single-root v0.3 configs.
 */

const { Project, Node, ScriptTarget, ModuleKind, ModuleResolutionKind } = require('ts-morph');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, resolveRelative } = require('./config.js');

const TOOL_VERSION = '0.4.0';
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SOURCE_EXT_STRIP_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const BORING_EXTERNALS = new Set([
  'json', 'status', 'send', 'sendStatus', 'redirect', 'cookie', 'clearCookie', 'setHeader', 'end', 'render',
  'log', 'error', 'warn', 'info', 'debug', 'trace',
  'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'forEach', 'map', 'filter',
  'find', 'findIndex', 'some', 'every', 'reduce', 'reduceRight', 'includes',
  'indexOf', 'lastIndexOf', 'concat', 'flat', 'flatMap', 'sort', 'reverse',
  'split', 'join', 'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase',
  'substring', 'substr', 'startsWith', 'endsWith', 'replace', 'replaceAll',
  'repeat', 'padStart', 'padEnd', 'charAt', 'charCodeAt', 'match', 'search',
  'keys', 'values', 'entries', 'assign', 'freeze', 'create', 'fromEntries',
  'stringify', 'parse', 'isArray', 'from', 'of', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Date',
  'now', 'abs', 'floor', 'ceil', 'round', 'max', 'min', 'random',
  'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'allSettled', 'race',
]);

function isBuiltinLibPath(filePath) {
  return (
    filePath.includes(`${path.sep}typescript${path.sep}lib${path.sep}lib.`) ||
    filePath.includes(`${path.sep}@types${path.sep}node${path.sep}`) ||
    filePath.includes(`${path.sep}@types${path.sep}express`)
  );
}

function shouldSkipExternal(decl, name) {
  const filePath = decl.getSourceFile().getFilePath();
  if (isBuiltinLibPath(filePath) && BORING_EXTERNALS.has(name)) return true;
  if (BORING_EXTERNALS.has(name)) return true;
  return false;
}

function makeGit(repoDir) {
  return (cmd) =>
    execSync(`git -C "${repoDir}" ${cmd}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
}

function autoDetectBaseBranch(git) {
  for (const b of ['main', 'master', 'develop']) {
    try {
      git(`rev-parse --verify ${b}`);
      return b;
    } catch {
      /* try next */
    }
  }
  return null;
}

function parseRemoteTrackingRef(git, ref) {
  let remotes;
  try {
    remotes = git('remote').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
  for (const remote of remotes) {
    if (ref.startsWith(remote + '/')) {
      return { remote, branch: ref.slice(remote.length + 1) };
    }
  }
  return null;
}

function checkBaseFreshness(repoDir, git, baseBranch) {
  const parsed = parseRemoteTrackingRef(git, baseBranch);
  if (!parsed) return;

  let localSha;
  try {
    localSha = git(`rev-parse ${baseBranch}`).trim();
  } catch {
    return;
  }

  let remoteOut;
  try {
    remoteOut = execSync(
      `git -C "${repoDir}" ls-remote ${parsed.remote} refs/heads/${parsed.branch}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
    );
  } catch (e) {
    const msg = (e && e.message ? String(e.message) : 'unknown error').split('\n')[0];
    console.error(`[pintu] (couldn't verify ${parsed.remote} freshness: ${msg} — using local copy)`);
    return;
  }

  const remoteSha = (remoteOut.split(/\s+/)[0] || '').trim();
  if (!remoteSha) {
    console.error(`[pintu] (remote returned no SHA for ${parsed.branch} — using local copy)`);
    return;
  }

  if (localSha === remoteSha) {
    console.error(`[pintu] base up-to-date with ${parsed.remote}`);
    return;
  }

  console.error('');
  console.error(`[pintu] ⚠  Your local "${baseBranch}" is OUT OF SYNC with ${parsed.remote}.`);
  console.error(`[pintu]    local:  ${localSha.slice(0, 12)}`);
  console.error(`[pintu]    remote: ${remoteSha.slice(0, 12)}`);
  console.error(`[pintu]    Run \`git fetch ${parsed.remote} ${parsed.branch}\` to refresh, then re-run.`);
  console.error(`[pintu]    (Pass --skip-base-check to suppress this warning.)`);
  console.error('');
}

function loadFromTsConfig(tsConfigPath) {
  console.error(`[pintu]   loading project from ${tsConfigPath}`);
  return new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: false,
  });
}

function synthesizeProject(serverRoot) {
  console.error(`[pintu]   synthesizing JS/TS project rooted at ${serverRoot}`);
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      target: ScriptTarget.Latest,
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      allowSyntheticDefaultImports: true,
    },
  });
  const globs = [
    path.join(serverRoot, '**/*.ts').replace(/\\/g, '/'),
    path.join(serverRoot, '**/*.tsx').replace(/\\/g, '/'),
    path.join(serverRoot, '**/*.js').replace(/\\/g, '/'),
    path.join(serverRoot, '**/*.jsx').replace(/\\/g, '/'),
    path.join(serverRoot, '**/*.mjs').replace(/\\/g, '/'),
    path.join(serverRoot, '**/*.cjs').replace(/\\/g, '/'),
    `!${path.join(serverRoot, '**/node_modules/**').replace(/\\/g, '/')}`,
  ];
  project.addSourceFilesAtPaths(globs);
  return project;
}

function autoFindTsConfig(serverRoot, project) {
  for (const p of [path.join(serverRoot, 'tsconfig.json'), path.join(project, 'tsconfig.json')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function autoFindAppEntry(serverRoot) {
  for (const ext of ['ts', 'js', 'mjs', 'cjs']) {
    const p = path.join(serverRoot, `app.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  for (const ext of ['ts', 'js', 'mjs', 'cjs']) {
    const p = path.join(serverRoot, `index.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return path.join(serverRoot, 'app.ts');
}

function normalizeMode(m) {
  return m && ['routes', 'touched'].includes(m) ? m : null;
}

function resolveSettings(args) {
  const cwd = process.cwd();
  const flags = args.flags || {};
  const explicitProject = flags.project ? path.resolve(cwd, String(flags.project)) : null;
  const searchDir = explicitProject || cwd;
  const { config, path: configPath, rootDir: configRoot } = loadConfig(searchDir);

  const project = explicitProject
    || resolveRelative(configRoot, config.project)
    || configRoot;

  const outDir = flags['out-dir']
    ? path.resolve(cwd, String(flags['out-dir']))
    : (resolveRelative(configRoot, config.outDir) || path.join(project, 'documents/pr-traces'));

  const baseBranch = flags.base ? String(flags.base) : (config.baseBranch || null);

  const depth = parseInt(
    flags.depth !== undefined ? String(flags.depth) : (config.depth || 4),
    10,
  );

  const prNum = flags['pr-num'] ? String(flags['pr-num']) : 'wip';
  const title = flags.title ? String(flags.title) : null;

  const topLevelMode = normalizeMode(flags.mode ? String(flags.mode) : null)
    || normalizeMode(config.mode);

  let roots;
  const cliOverridesRoot = flags['server-root'] || flags['ts-config'] || flags['app-entry'] || flags['routes-pattern'];

  if (cliOverridesRoot) {
    roots = [{
      label: 'cli',
      serverRoot: flags['server-root']
        ? path.resolve(cwd, String(flags['server-root']))
        : (resolveRelative(configRoot, config.serverRoot) || project),
      tsConfig: flags['ts-config']
        ? path.resolve(cwd, String(flags['ts-config']))
        : resolveRelative(configRoot, config.tsConfig),
      appEntry: flags['app-entry']
        ? path.resolve(cwd, String(flags['app-entry']))
        : resolveRelative(configRoot, config.appEntry),
      mode: topLevelMode,
      routesPattern: flags['routes-pattern']
        ? String(flags['routes-pattern'])
        : (config.routesPattern || null),
    }];
  } else if (Array.isArray(config.roots) && config.roots.length > 0) {
    roots = config.roots.map((r, i) => ({
      label: r.label || (r.serverRoot ? path.basename(r.serverRoot) : `root-${i}`),
      serverRoot: resolveRelative(configRoot, r.serverRoot) || project,
      tsConfig: resolveRelative(configRoot, r.tsConfig),
      appEntry: resolveRelative(configRoot, r.appEntry),
      mode: normalizeMode(r.mode) || topLevelMode,
      routesPattern: r.routesPattern || null,
    }));
  } else {
    roots = [{
      label: 'default',
      serverRoot: resolveRelative(configRoot, config.serverRoot) || project,
      tsConfig: resolveRelative(configRoot, config.tsConfig),
      appEntry: resolveRelative(configRoot, config.appEntry),
      mode: topLevelMode,
      routesPattern: config.routesPattern || null,
    }];
  }

  for (const r of roots) {
    if (!r.tsConfig) r.tsConfig = autoFindTsConfig(r.serverRoot, project);
    if (!r.appEntry) r.appEntry = autoFindAppEntry(r.serverRoot);
    if (!r.routesPattern) r.routesPattern = '/routes/';
  }

  return {
    project, outDir, baseBranch, depth, prNum, title,
    topLevelMode, roots,
    configPath,
  };
}

async function selectMode(initialMode) {
  if (initialMode === 'routes' || initialMode === 'touched') return initialMode;
  if (!process.stdin.isTTY) return 'routes';
  const p = require('@clack/prompts');
  p.intro('agent-pintu');
  const choice = await p.select({
    message: 'Choose trace mode:',
    options: [
      { value: 'routes',  label: 'routes',  hint: 'Walk from changed Express route handlers (backend servers)' },
      { value: 'touched', label: 'touched', hint: 'Walk from every function touched by the diff (any code)' },
    ],
    initialValue: 'routes',
  });
  if (p.isCancel(choice)) {
    p.cancel('Aborted.');
    process.exit(130);
  }
  return String(choice);
}

async function runTrace(args) {
  const s = resolveSettings(args);
  const git = makeGit(s.project);

  if (!fs.existsSync(path.join(s.project, '.git'))) {
    throw new Error(`Not a git repo: ${s.project}`);
  }
  for (const r of s.roots) {
    if (r.tsConfig && !fs.existsSync(r.tsConfig)) {
      throw new Error(`tsconfig not found for root "${r.label}": ${r.tsConfig} (remove from .pintu.json or fix the path)`);
    }
  }

  const rootsMissingMode = s.roots.filter((r) => !r.mode);
  if (rootsMissingMode.length > 0) {
    const fallback = await selectMode(s.topLevelMode);
    for (const r of rootsMissingMode) r.mode = fallback;
  }

  const baseBranch = s.baseBranch || autoDetectBaseBranch(git);
  if (!baseBranch) {
    throw new Error('Could not auto-detect base branch (tried main, master, develop). Pass --base <branch>.');
  }
  const title = s.title || `Trace vs ${baseBranch}`;

  if (!args.flags['skip-base-check']) {
    checkBaseFreshness(s.project, git, baseBranch);
  }

  console.error(`[pintu] project:      ${s.project}`);
  console.error(`[pintu] roots:        ${s.roots.length}`);
  for (const r of s.roots) {
    console.error(`[pintu]   - ${r.label.padEnd(14)} ${path.relative(s.project, r.serverRoot).padEnd(28)} [mode: ${r.mode}]`);
  }
  console.error(`[pintu] base branch:  ${baseBranch}`);
  console.error(`[pintu] out dir:      ${s.outDir}`);
  if (s.configPath) console.error(`[pintu] config:       ${s.configPath}`);

  const all = changedFiles(git, baseBranch);
  if (!all.length) {
    throw new Error(`No diff vs ${baseBranch} — nothing to trace.`);
  }

  const fileHunks = {};
  for (const f of all) fileHunks[f] = diffHunksForFile(git, baseBranch, f);

  const sharedNodes = new Map();
  const sharedEdges = [];
  const sharedEdgeIdx = new Map();
  const rootResults = [];

  for (const root of s.roots) {
    const serverRel = path.relative(s.project, root.serverRoot);
    const serverPrefix = serverRel ? serverRel.replace(/\\/g, '/') + '/' : '';
    const rootFiles = all.filter((f) => f.startsWith(serverPrefix) && SOURCE_EXT_RE.test(f));
    const routeFilesInRoot = rootFiles.filter((f) => f.includes(root.routesPattern));

    console.error('');
    console.error(`[pintu] ── root: ${root.label} (mode: ${root.mode}) ──`);
    console.error(`[pintu]   ${rootFiles.length} source file(s) changed under this root`);

    if (rootFiles.length === 0) {
      console.error(`[pintu]   (no changes — skipping)`);
      rootResults.push({ root, entries: [], skipped: true, reason: 'no-changes' });
      continue;
    }

    const tsProject = root.tsConfig
      ? loadFromTsConfig(root.tsConfig)
      : synthesizeProject(root.serverRoot);

    let entries;
    if (root.mode === 'touched') {
      entries = findTouchedEntries(tsProject, s.project, rootFiles, fileHunks);
    } else {
      entries = findRouteEntries(tsProject, s.project, routeFilesInRoot);
      if (entries.length) {
        const mounts = buildMountIndex(tsProject, root.appEntry);
        const appFile = tsProject.getSourceFile(root.appEntry);
        for (const e of entries) {
          const routeRel = e.routeFile.replace(SOURCE_EXT_STRIP_RE, '');
          const importerHit =
            appFile &&
            Object.keys(mounts).find((v) => {
              const imp = appFile
                .getImportDeclarations()
                .find((d) => d.getModuleSpecifierValue().endsWith(path.basename(routeRel)));
              if (!imp) return false;
              const named = imp.getDefaultImport()?.getText() || imp.getNamespaceImport()?.getText();
              return named === v;
            });
          e.fullPath = (importerHit ? mounts[importerHit] : '') + e.routePath;
          e.displayPath = e.fullPath
            .replace(/\(\$\{[^}]+\}\)/g, '')
            .replace(/\([^)]*\)/g, '');
          e.routeTag = `${e.method} ${e.displayPath}`;
        }
      }
    }

    if (!entries.length) {
      const reason = root.mode === 'touched'
        ? 'no touched top-level functions in this root'
        : `no Express routes found (try mode 'touched' for this root)`;
      console.error(`[pintu]   ${reason}`);
      rootResults.push({ root, entries: [], skipped: true, reason });
      continue;
    }

    console.error(`[pintu]   entries:`);
    for (const e of entries) {
      console.error(`     ${e.method.padEnd(6)} ${(e.displayPath || e.routePath).padEnd(50)} → ${e.handlerName}`);
    }

    buildGraph({
      project: s.project,
      serverRoot: root.serverRoot,
      git,
      entries: entries.map((e) => ({ ...e, routePath: e.displayPath || e.routePath })),
      fileHunks,
      maxDepth: s.depth,
      nodes: sharedNodes,
      edges: sharedEdges,
      edgeIdx: sharedEdgeIdx,
      rootLabel: root.label,
    });

    rootResults.push({
      root,
      entries: entries.map((e) => ({
        ...e,
        entryId: declId(e.handlerDecl, s.project),
      })),
      skipped: false,
    });
  }

  const activeRoots = rootResults.filter((r) => !r.skipped);
  if (!activeRoots.length) {
    const hint = s.roots.length === 1
      ? (s.roots[0].mode === 'routes'
          ? 'Hint: no Express routes were detected. Try --mode touched.'
          : 'Hint: the PR may only change non-code files (HTML, SQL, etc.).')
      : 'Hint: none of the configured roots had matching source changes in this diff.';
    throw new Error(`No traceable entries found.\n${hint}`);
  }

  console.error('');
  console.error(`[pintu] combined graph: ${sharedNodes.size} nodes, ${sharedEdges.length} edges across ${activeRoots.length} root(s)`);

  const md = renderMarkdown({
    title,
    base: baseBranch,
    nodes: sharedNodes,
    edges: sharedEdges,
    rootResults,
    project: s.project,
    isMultiRoot: s.roots.length > 1,
  });

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const outPath = path.join(s.outDir, `PR-${s.prNum}-${slug}.md`);
  const yamlPath = outPath.replace(/\.md$/, '.yaml');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md + `---\n\n*Machine-readable graph: [${path.basename(yamlPath)}](./${path.basename(yamlPath)})*\n`);
  fs.writeFileSync(yamlPath, machineYaml({
    prNum: s.prNum,
    title,
    base: baseBranch,
    rootResults,
    nodes: sharedNodes,
    edges: sharedEdges,
    isMultiRoot: s.roots.length > 1,
    project: s.project,
  }));
  console.error(
    `[pintu] wrote ${path.relative(s.project, outPath)} + ${path.relative(s.project, yamlPath)}`,
  );
}

// ---------- git helpers ----------

function changedFiles(git, base) {
  return git(`diff --name-only ${base}...HEAD`)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function diffHunksForFile(git, base, file) {
  let out;
  try {
    out = git(`diff -U0 ${base}...HEAD -- "${file}"`);
  } catch {
    return [];
  }
  const ranges = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      const start = parseInt(m[1], 10);
      const count = m[2] ? parseInt(m[2], 10) : 1;
      if (count > 0) ranges.push({ startLine: start, endLine: start + count - 1 });
    }
  }
  return ranges;
}

function symbolTimestamps(git, file, startLine, endLine) {
  try {
    const out = git(`log --pretty=format:%H%x09%aI -L ${startLine},${endLine}:"${file}" -s`);
    const lines = out.split('\n').filter(Boolean);
    if (!lines.length) return { created: null, updated: null, commits: [] };
    const parsed = lines.map((l) => {
      const [hash, iso] = l.split('\t');
      return { hash, iso };
    });
    return {
      created: parsed[parsed.length - 1].iso,
      updated: parsed[0].iso,
      commits: parsed.map((p) => p.hash.slice(0, 8)),
    };
  } catch {
    return { created: null, updated: null, commits: [] };
  }
}

// ---------- touched-function entry detection (mode: touched) ----------

function isTopLevelFunction(decl) {
  let parent = decl.getParent();
  while (parent) {
    if (Node.isSourceFile(parent)) return true;
    if (
      Node.isFunctionDeclaration(parent) ||
      Node.isMethodDeclaration(parent) ||
      Node.isArrowFunction(parent) ||
      Node.isFunctionExpression(parent)
    ) {
      return false;
    }
    parent = parent.getParent();
  }
  return true;
}

function findTouchedEntries(tsProject, projectRoot, changedFiles, fileHunks) {
  const entries = [];
  const seen = new Set();

  for (const rel of changedFiles) {
    const abs = path.join(projectRoot, rel);
    const sf = tsProject.getSourceFile(abs);
    if (!sf) continue;

    sf.forEachDescendant((node) => {
      if (
        !Node.isFunctionDeclaration(node) &&
        !Node.isMethodDeclaration(node) &&
        !Node.isArrowFunction(node) &&
        !Node.isFunctionExpression(node)
      ) return;

      if (!isTopLevelFunction(node)) return;

      const range = { start: node.getStartLineNumber(), end: node.getEndLineNumber() };
      const hunks = fileHunks[rel] || [];
      const isTouched = hunks.some((h) => !(range.end < h.startLine || range.start > h.endLine));
      if (!isTouched) return;

      const key = `${rel}:${range.start}`;
      if (seen.has(key)) return;
      seen.add(key);

      const name = getDeclName(node) || `<anon@L${range.start}>`;
      entries.push({
        method: 'FN',
        routePath: `${rel}:${range.start}`,
        routeFile: rel,
        handlerName: name,
        handlerDecl: node,
      });
    });
  }
  return entries;
}

// ---------- route entry detection ----------

function findRouteEntries(tsProject, projectRoot, changedRouteFiles) {
  const entries = [];
  for (const rel of changedRouteFiles) {
    const abs = path.join(projectRoot, rel);
    const sf = tsProject.getSourceFile(abs);
    if (!sf) {
      console.error(`[pintu]   skip (no source file): ${rel}`);
      continue;
    }
    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      const method = expr.getName();
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) return;

      const callArgs = node.getArguments();
      let routePath = null;
      let handlerArg = null;

      const lhs = expr.getExpression();
      if (Node.isCallExpression(lhs)) {
        const inner = lhs.getExpression();
        if (Node.isPropertyAccessExpression(inner) && inner.getName() === 'route') {
          const ra = lhs.getArguments()[0];
          if (ra) routePath = ra.getText().replace(/^[`'"]|[`'"]$/g, '');
          handlerArg = callArgs[0];
        }
      }
      if (!handlerArg && callArgs.length >= 2) {
        routePath = callArgs[0].getText().replace(/^[`'"]|[`'"]$/g, '');
        handlerArg = callArgs[callArgs.length - 1];
      }

      if (!handlerArg) return;

      let resolvedDecl;
      let handlerName;

      if (Node.isIdentifier(handlerArg)) {
        const sym = handlerArg.getSymbol();
        const decl = sym && sym.getDeclarations()[0];
        if (!decl) return;
        resolvedDecl = decl;
        if (Node.isImportSpecifier(decl) || Node.isImportClause(decl)) {
          const aliased = sym.getAliasedSymbol && sym.getAliasedSymbol();
          if (aliased) {
            const d = aliased.getDeclarations()[0];
            if (d) resolvedDecl = d;
          }
        }
        handlerName = handlerArg.getText();
      } else if (Node.isArrowFunction(handlerArg) || Node.isFunctionExpression(handlerArg)) {
        resolvedDecl = handlerArg;
        handlerName = `<inline ${method}@L${handlerArg.getStartLineNumber()}>`;
      } else {
        return;
      }

      entries.push({
        method: method.toUpperCase(),
        routePath: routePath || '?',
        routeFile: rel,
        handlerName,
        handlerDecl: resolvedDecl,
      });
    });
  }
  return entries;
}

// ---------- mount-prefix detection ----------

function buildMountIndex(tsProject, appEntry) {
  const appFile = tsProject.getSourceFile(appEntry);
  const index = {};
  if (!appFile) return index;

  const usages = [];
  appFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== 'use') return;
    const callArgs = node.getArguments();
    if (callArgs.length < 2) return;
    const first = callArgs[0];
    if (!Node.isStringLiteral(first) && !Node.isNoSubstitutionTemplateLiteral(first)) return;
    const prefix = first.getLiteralText();
    const lastArg = callArgs[callArgs.length - 1];
    if (!Node.isIdentifier(lastArg)) return;
    usages.push({
      parent: expr.getExpression().getText(),
      prefix,
      child: lastArg.getText(),
    });
  });

  for (const u of usages) index[u.child] = u;

  const fullPath = (varName, seen = new Set()) => {
    if (seen.has(varName)) return '';
    seen.add(varName);
    const u = index[varName];
    if (!u) return '';
    return fullPath(u.parent, seen) + u.prefix;
  };

  const out = {};
  for (const varName of Object.keys(index)) out[varName] = fullPath(varName);
  return out;
}

// ---------- call-graph walk ----------

function declId(decl, projectRoot) {
  const sf = decl.getSourceFile();
  const rel = path.relative(projectRoot, sf.getFilePath());
  const name = getDeclName(decl) || `<anon@${decl.getStartLineNumber()}>`;
  return `${rel}:${name}`;
}

function getDeclName(decl) {
  if (Node.isFunctionDeclaration(decl)) return decl.getName();
  if (Node.isMethodDeclaration(decl)) return decl.getName();
  if (Node.isVariableDeclaration(decl)) return decl.getName();
  if (Node.isPropertyAssignment(decl)) return decl.getName();
  if (Node.isShorthandPropertyAssignment(decl)) return decl.getName();
  if (Node.isClassDeclaration(decl)) return decl.getName();
  if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) {
    const parent = decl.getParent();
    if (Node.isVariableDeclaration(parent)) return parent.getName();
    if (Node.isPropertyAssignment(parent)) return parent.getName();
  }
  if (typeof decl.getName === 'function') return decl.getName();
  return null;
}

function declRange(decl) {
  return { start: decl.getStartLineNumber(), end: decl.getEndLineNumber() };
}

function bodyOf(decl) {
  if (Node.isFunctionDeclaration(decl)) return decl.getBody();
  if (Node.isMethodDeclaration(decl)) return decl.getBody();
  if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) return decl.getBody();
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init.getBody();
  }
  if (Node.isClassDeclaration(decl)) return decl;
  return null;
}

function isFunctionLikeDecl(decl) {
  if (Node.isFunctionDeclaration(decl)) return true;
  if (Node.isMethodDeclaration(decl)) return true;
  if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) return true;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return true;
  }
  return false;
}

function rangesIntersect(a, b) {
  return !(a.end < b.startLine || a.start > b.endLine);
}

function nodeIsTouched(decl, fileHunks, projectRoot) {
  const range = declRange(decl);
  const rel = path.relative(projectRoot, decl.getSourceFile().getFilePath());
  const hunks = fileHunks[rel];
  if (!hunks) return false;
  return hunks.some((h) => rangesIntersect(range, h));
}

function buildGraph({ project, serverRoot, git, entries, fileHunks, maxDepth, nodes, edges, edgeIdx, rootLabel }) {
  nodes = nodes || new Map();
  edges = edges || [];
  edgeIdx = edgeIdx || new Map();
  const edgeKey = (f, t) => `${f}→${t}`;

  function isInProject(decl) {
    const filePath = decl.getSourceFile().getFilePath();
    return filePath.startsWith(serverRoot + path.sep) && !filePath.includes(`${path.sep}node_modules${path.sep}`);
  }

  function tagRoot(rec) {
    if (!rootLabel) return rec;
    if (!rec.roots) rec.roots = [];
    if (!rec.roots.includes(rootLabel)) rec.roots.push(rootLabel);
    return rec;
  }

  function addNode(decl, { isEntry = false, isExternal = false, route = null } = {}) {
    const id = declId(decl, project);
    if (nodes.has(id)) {
      const n = nodes.get(id);
      if (isEntry) n.isEntry = true;
      if (route && !n.routes.includes(route)) n.routes.push(route);
      return tagRoot(n);
    }
    const sf = decl.getSourceFile();
    const rel = path.relative(project, sf.getFilePath());
    const range = declRange(decl);
    const ts = isExternal
      ? { created: null, updated: null, commits: [] }
      : symbolTimestamps(git, rel, range.start, range.end);
    const touched = isExternal ? false : nodeIsTouched(decl, fileHunks, project);
    const rec = {
      id,
      name: getDeclName(decl) || '<anon>',
      file: rel,
      line: range.start,
      endLine: range.end,
      isEntry,
      isExternal,
      touched,
      routes: route ? [route] : [],
      roots: [],
      created: ts.created,
      updated: ts.updated,
      commits: ts.commits,
    };
    nodes.set(id, rec);
    return tagRoot(rec);
  }

  function addEdge(fromId, toId, callSite) {
    const k = edgeKey(fromId, toId);
    let idx = edgeIdx.get(k);
    if (idx === undefined) {
      idx = edges.length;
      edges.push({ from: fromId, to: toId, callSites: [] });
      edgeIdx.set(k, idx);
    }
    if (callSite) edges[idx].callSites.push(callSite);
  }

  const walked = new Set();

  function walk(decl, depth) {
    if (depth > maxDepth) return;
    const fromId = declId(decl, project);
    const body = bodyOf(decl);
    if (!body) return;

    body.forEachDescendant((n) => {
      if (!Node.isCallExpression(n)) return;
      const callExpr = n.getExpression();
      let s;
      try {
        s = callExpr.getSymbol();
      } catch {
        s = null;
      }
      if (!s) return;
      const aliased = s.getAliasedSymbol && s.getAliasedSymbol();
      const resolvedSym = aliased || s;
      const decls = resolvedSym.getDeclarations();
      if (!decls || !decls.length) return;
      const calleeDecl = decls[0];

      if (!isInProject(calleeDecl)) {
        const extName = resolvedSym.getName() || callExpr.getText();
        if (shouldSkipExternal(calleeDecl, extName)) return;
        const extFile = calleeDecl.getSourceFile().getFilePath();
        const extId = `external:${extName}`;
        if (!nodes.has(extId)) {
          nodes.set(extId, {
            id: extId,
            name: extName,
            file: path.relative(project, extFile),
            line: calleeDecl.getStartLineNumber(),
            endLine: calleeDecl.getEndLineNumber(),
            isEntry: false,
            isExternal: true,
            touched: false,
            routes: [],
            roots: [],
            created: null,
            updated: null,
            commits: [],
          });
        }
        tagRoot(nodes.get(extId));
        addEdge(fromId, extId, {
          line: n.getStartLineNumber(),
          args: n.getArguments().map((a) => a.getText().slice(0, 60)),
        });
        return;
      }

      if (!isFunctionLikeDecl(calleeDecl)) return;

      addNode(calleeDecl);
      addEdge(fromId, declId(calleeDecl, project), {
        line: n.getStartLineNumber(),
        args: n.getArguments().map((a) => a.getText().slice(0, 60)),
      });

      const calleeId = declId(calleeDecl, project);
      if (!walked.has(calleeId)) {
        walked.add(calleeId);
        walk(calleeDecl, depth + 1);
      }
    });
  }

  for (const e of entries) {
    const rec = addNode(e.handlerDecl, {
      isEntry: true,
      route: `${e.method} ${e.routePath}`,
    });
    if (!walked.has(rec.id)) {
      walked.add(rec.id);
      walk(e.handlerDecl, 1);
    }
  }
  return { nodes, edges };
}

// ---------- emit ----------

function escId(id) {
  return id.replace(/[^A-Za-z0-9]/g, '_');
}

function shortFile(f, projectRoot, serverRoot) {
  const serverRel = path.relative(projectRoot, serverRoot);
  let out = f;
  if (serverRel && out.startsWith(serverRel + '/')) {
    out = out.slice(serverRel.length + 1);
    if (out.startsWith('src/')) out = out.slice(4);
  }
  return out.replace(SOURCE_EXT_STRIP_RE, '');
}

function mermaid(nodes, edges, restrictToIds, projectRoot, serverRoot) {
  const lines = ['```mermaid', 'flowchart LR'];
  const include = restrictToIds ? new Set(restrictToIds) : new Set(nodes.keys());
  for (const [id, n] of nodes) {
    if (!include.has(id)) continue;
    const label = n.isExternal
      ? `🔌 ${n.name}`
      : `${n.name}\\n<small>${shortFile(n.file, projectRoot, serverRoot)}:${n.line}</small>`;
    const shape = n.isEntry ? `[["${label}"]]` : n.isExternal ? `(["${label}"])` : `["${label}"]`;
    lines.push(`  ${escId(id)}${shape}`);
    if (n.touched) lines.push(`  class ${escId(id)} touched`);
    if (n.isExternal) lines.push(`  class ${escId(id)} external`);
    if (n.isEntry) lines.push(`  class ${escId(id)} entry`);
  }
  for (const e of edges) {
    if (!include.has(e.from) || !include.has(e.to)) continue;
    const cs = e.callSites[0];
    const argPreview = cs && cs.args.length
      ? cs.args.slice(0, 2).map((a) => a.replace(/\n/g, ' ')).join(', ')
      : '';
    const label = argPreview ? `|"${argPreview.replace(/"/g, "'")}"|` : '';
    lines.push(`  ${escId(e.from)} -->${label} ${escId(e.to)}`);
  }
  lines.push(
    '  classDef touched fill:#ffe0b3,stroke:#d97706,color:#000',
    '  classDef entry fill:#bfdbfe,stroke:#1d4ed8,color:#000',
    '  classDef external fill:#e5e7eb,stroke:#6b7280,color:#374151',
  );
  lines.push('```');
  return lines.join('\n');
}

function reachableFrom(entryIds, edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const visited = new Set();
  const stack = [...entryIds];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const to of adj.get(id) || []) stack.push(to);
  }
  return visited;
}

function machineYaml(meta) {
  const { prNum, title, base, rootResults, nodes, edges, isMultiRoot, project } = meta;
  const lines = [];
  lines.push(`pr: "${prNum}"`);
  lines.push(`title: ${JSON.stringify(title)}`);
  lines.push(`base_branch: "${base}"`);
  lines.push(`generated_at: "${new Date().toISOString()}"`);
  lines.push(`tool: agent-pintu v${TOOL_VERSION}`);

  if (isMultiRoot) {
    lines.push('roots:');
    for (const rr of rootResults) {
      lines.push(`  - label: ${JSON.stringify(rr.root.label)}`);
      lines.push(`    server_root: ${JSON.stringify(path.relative(project, rr.root.serverRoot))}`);
      lines.push(`    mode: ${rr.root.mode}`);
      lines.push(`    skipped: ${rr.skipped}`);
      if (rr.skipped) lines.push(`    skip_reason: ${JSON.stringify(rr.reason || '')}`);
      if (rr.entries.length) {
        lines.push(`    entries:`);
        for (const e of rr.entries) {
          lines.push(`      - method: ${e.method}`);
          lines.push(`        path: "${e.displayPath || e.routePath || e.fullPath || ''}"`);
          lines.push(`        handler: ${JSON.stringify(e.handlerName)}`);
          lines.push(`        route_file: ${JSON.stringify(e.routeFile)}`);
        }
      }
    }
  }

  // Always emit flat entry_routes for backward compat
  lines.push('entry_routes:');
  for (const rr of rootResults) {
    for (const e of rr.entries) {
      lines.push(`  - method: ${e.method}`);
      lines.push(`    path: "${e.displayPath || e.routePath || e.fullPath || ''}"`);
      lines.push(`    handler: ${JSON.stringify(e.handlerName)}`);
      lines.push(`    route_file: ${JSON.stringify(e.routeFile)}`);
      if (isMultiRoot) lines.push(`    root: ${JSON.stringify(rr.root.label)}`);
    }
  }

  lines.push('nodes:');
  for (const [id, n] of nodes) {
    lines.push(`  - id: ${JSON.stringify(id)}`);
    lines.push(`    name: ${JSON.stringify(n.name)}`);
    lines.push(`    file: ${JSON.stringify(n.file)}`);
    lines.push(`    line: ${n.line}`);
    lines.push(`    end_line: ${n.endLine}`);
    lines.push(`    kind: ${n.isExternal ? 'external' : n.isEntry ? 'entry' : 'internal'}`);
    lines.push(`    touched_in_pr: ${n.touched}`);
    if (n.routes.length) lines.push(`    routes: ${JSON.stringify(n.routes)}`);
    if (isMultiRoot && n.roots && n.roots.length) lines.push(`    roots: ${JSON.stringify(n.roots)}`);
    if (n.created) lines.push(`    created: "${n.created}"`);
    if (n.updated) lines.push(`    updated: "${n.updated}"`);
  }
  lines.push('edges:');
  for (const e of edges) {
    lines.push(`  - from: ${JSON.stringify(e.from)}`);
    lines.push(`    to: ${JSON.stringify(e.to)}`);
    if (e.callSites.length) {
      lines.push(`    call_sites:`);
      for (const cs of e.callSites.slice(0, 5)) {
        lines.push(`      - line: ${cs.line}`);
        if (cs.args && cs.args.length) lines.push(`        args: ${JSON.stringify(cs.args)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function tableFor(entryId, edges, nodeMap, projectRoot, serverRoot) {
  const ids = [...reachableFrom([entryId], edges)];
  const rows = [
    '| Function | File:Line | Kind | Touched | Last updated |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const id of ids) {
    const n = nodeMap.get(id);
    if (!n) continue;
    const kind = n.isExternal ? 'external' : n.isEntry ? 'entry' : 'internal';
    const updated = n.updated ? n.updated.slice(0, 10) : '—';
    rows.push(
      `| \`${n.name}\` | \`${shortFile(n.file, projectRoot, serverRoot)}:${n.line}\` | ${kind} | ${n.touched ? '✓' : ''} | ${updated} |`,
    );
  }
  return rows.join('\n');
}

function renderMarkdown({ title, base, nodes, edges, rootResults, project, isMultiRoot }) {
  let md = '';
  md += `# ${title}\n\n`;
  md += `**Base:** \`${base}\` • **Generated:** ${new Date().toISOString()} • **Nodes:** ${nodes.size} • **Edges:** ${edges.length}\n\n`;
  if (isMultiRoot) {
    const summary = rootResults.map((rr) => {
      if (rr.skipped) return `${rr.root.label} (skipped)`;
      return `${rr.root.label} (${rr.root.mode}, ${rr.entries.length} entries)`;
    }).join(' • ');
    md += `**Roots:** ${summary}\n\n`;
  }
  md += `> Orange = touched by this PR. Blue = entry. Gray = external/library.\n\n`;

  md += `## Combined call graph\n\n`;
  const firstRoot = rootResults.find((rr) => !rr.skipped);
  const renderServerRoot = firstRoot ? firstRoot.root.serverRoot : project;
  md += mermaid(nodes, edges, null, project, renderServerRoot) + '\n\n';

  for (const rr of rootResults) {
    if (rr.skipped) continue;
    if (isMultiRoot) {
      md += `## Root: ${rr.root.label} (${rr.root.mode})\n\n`;
      md += `**Server root:** \`${path.relative(project, rr.root.serverRoot)}\` • **Entries:** ${rr.entries.length}\n\n`;
    }
    for (const pe of rr.entries) {
      const heading = pe.method === 'FN'
        ? `${isMultiRoot ? '### ' : '## '}${pe.handlerName}`
        : `${isMultiRoot ? '### ' : '## '}${pe.method} ${pe.displayPath || pe.fullPath || pe.routePath}`;
      md += `${heading}\n\n`;
      md += `Handler: \`${pe.handlerName}\` — \`${shortFile(pe.routeFile, project, rr.root.serverRoot)}\`\n\n`;
      const reachable = reachableFrom([pe.entryId], edges);
      md += mermaid(nodes, edges, reachable, project, rr.root.serverRoot) + '\n\n';
      md += tableFor(pe.entryId, edges, nodes, project, rr.root.serverRoot) + '\n\n';
    }
  }

  const reachedAny = new Set();
  for (const rr of rootResults) {
    for (const pe of rr.entries) for (const id of reachableFrom([pe.entryId], edges)) reachedAny.add(id);
  }
  const orphans = [...nodes.values()].filter((n) => n.touched && !reachedAny.has(n.id));
  if (orphans.length) {
    md += `## Touched code not reached from any traced entry\n\n`;
    md += `These functions were modified by this PR but aren't reachable from the entries above — likely cron jobs, CLI scripts, admin-only paths, or callers from outside the traced roots.\n\n`;
    md += `| Function | File:Line | Last updated |\n| --- | --- | --- |\n`;
    for (const n of orphans) {
      md += `| \`${n.name}\` | \`${shortFile(n.file, project, renderServerRoot)}:${n.line}\` | ${n.updated ? n.updated.slice(0, 10) : '—'} |\n`;
    }
    md += '\n';
  }
  return md;
}

module.exports = { runTrace };
