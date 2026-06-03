/**
 * PR call-graph extractor — emits Mermaid + YAML artifacts.
 *
 * Walks the AST from each route handler touched by the current diff (vs
 * --base), resolving callees via the ts-morph type checker. External symbols
 * become terminal nodes. Stdlib noise is filtered via BORING_EXTERNALS.
 */

const { Project, Node } = require('ts-morph');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, resolveRelative } = require('./config.js');

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

function resolveSettings(args) {
  const cwd = process.cwd();
  const flags = args.flags || {};
  const explicitProject = flags.project ? path.resolve(cwd, String(flags.project)) : null;
  const searchDir = explicitProject || cwd;
  const { config, path: configPath, rootDir: configRoot } = loadConfig(searchDir);

  const project = explicitProject
    || resolveRelative(configRoot, config.project)
    || configRoot;

  const serverRoot = flags['server-root']
    ? path.resolve(cwd, String(flags['server-root']))
    : (resolveRelative(configRoot, config.serverRoot) || project);

  const tsConfigPath = flags['ts-config']
    ? path.resolve(cwd, String(flags['ts-config']))
    : (resolveRelative(configRoot, config.tsConfig) || path.join(serverRoot, 'tsconfig.json'));

  const appEntry = flags['app-entry']
    ? path.resolve(cwd, String(flags['app-entry']))
    : (resolveRelative(configRoot, config.appEntry) || path.join(serverRoot, 'app.ts'));

  const outDir = flags['out-dir']
    ? path.resolve(cwd, String(flags['out-dir']))
    : (resolveRelative(configRoot, config.outDir) || path.join(project, 'documents/pr-traces'));

  const baseBranch = flags.base
    ? String(flags.base)
    : (config.baseBranch || null);

  const routesPattern = flags['routes-pattern']
    ? String(flags['routes-pattern'])
    : (config.routesPattern || '/routes/');

  const depth = parseInt(
    flags.depth !== undefined ? String(flags.depth) : (config.depth || 4),
    10,
  );

  const prNum = flags['pr-num'] ? String(flags['pr-num']) : 'wip';
  const title = flags.title ? String(flags.title) : null;

  return {
    project,
    serverRoot,
    tsConfigPath,
    appEntry,
    outDir,
    baseBranch,
    routesPattern,
    depth,
    prNum,
    title,
    configPath,
  };
}

async function runTrace(args) {
  const s = resolveSettings(args);
  const git = makeGit(s.project);

  if (!fs.existsSync(path.join(s.project, '.git'))) {
    throw new Error(`Not a git repo: ${s.project}`);
  }
  if (!fs.existsSync(s.tsConfigPath)) {
    throw new Error(`tsconfig not found: ${s.tsConfigPath} (override with --ts-config)`);
  }

  const baseBranch = s.baseBranch || autoDetectBaseBranch(git);
  if (!baseBranch) {
    throw new Error('Could not auto-detect base branch (tried main, master, develop). Pass --base <branch>.');
  }
  const title = s.title || `Trace vs ${baseBranch}`;

  console.error(`[pintu] project:      ${s.project}`);
  console.error(`[pintu] server root:  ${s.serverRoot}`);
  console.error(`[pintu] tsconfig:     ${s.tsConfigPath}`);
  console.error(`[pintu] base branch:  ${baseBranch}`);
  console.error(`[pintu] out dir:      ${s.outDir}`);
  if (s.configPath) console.error(`[pintu] config:       ${s.configPath}`);

  const all = changedFiles(git, baseBranch);
  if (!all.length) {
    throw new Error(`No diff vs ${baseBranch} — nothing to trace.`);
  }
  const serverRel = path.relative(s.project, s.serverRoot);
  const serverPrefix = serverRel ? serverRel.replace(/\\/g, '/') + '/' : '';
  const serverFiles = all.filter((f) => f.startsWith(serverPrefix) && f.endsWith('.ts'));
  const routeFiles = serverFiles.filter((f) => f.includes(s.routesPattern));

  console.error(
    `[pintu] changed: ${all.length} files (${serverFiles.length} server .ts, ${routeFiles.length} route files)`,
  );

  console.error(`[pintu] loading TS project from ${s.tsConfigPath}`);
  const tsProject = new Project({
    tsConfigFilePath: s.tsConfigPath,
    skipAddingFilesFromTsConfig: false,
  });

  const fileHunks = {};
  for (const f of all) fileHunks[f] = diffHunksForFile(git, baseBranch, f);

  const entries = findRouteEntries(tsProject, s.project, routeFiles);
  if (!entries.length) {
    throw new Error('No route entries found in changed route files.');
  }

  const mounts = buildMountIndex(tsProject, s.appEntry);
  for (const e of entries) {
    const routeRel = e.routeFile.replace(/\.ts$/, '');
    const appFile = tsProject.getSourceFile(s.appEntry);
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

  console.error('[pintu] route entries:');
  for (const e of entries) {
    console.error(
      `  ${e.method.padEnd(6)} ${(e.displayPath || e.fullPath).padEnd(50)} → ${e.handlerName}  (${e.routeFile})`,
    );
  }

  const { nodes, edges } = buildGraph({
    project: s.project,
    serverRoot: s.serverRoot,
    git,
    entries: entries.map((e) => ({ ...e, routePath: e.displayPath })),
    fileHunks,
    maxDepth: s.depth,
  });
  console.error(`[pintu] graph: ${nodes.size} nodes, ${edges.length} edges`);

  const perEntry = entries.map((e) => ({
    ...e,
    entryId: declId(e.handlerDecl, s.project),
    edges,
  }));

  const md = renderMarkdown({
    title,
    base: baseBranch,
    nodes,
    edges,
    perEntry,
    serverRoot: s.serverRoot,
    project: s.project,
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
    entries: entries.map(({ method, fullPath, displayPath, handlerName, routeFile }) => ({
      method,
      fullPath: displayPath || fullPath,
      handlerName,
      routeFile,
    })),
    nodes,
    edges,
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

// ---------- route entry detection ----------

function findRouteEntries(tsProject, projectRoot, changedRouteFiles) {
  const entries = [];
  for (const rel of changedRouteFiles) {
    const abs = path.join(projectRoot, rel);
    const sf = tsProject.getSourceFile(abs);
    if (!sf) {
      console.error(`[pintu] skip (no source file): ${rel}`);
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

      if (!handlerArg || !Node.isIdentifier(handlerArg)) return;

      const sym = handlerArg.getSymbol();
      const decl = sym && sym.getDeclarations()[0];
      if (!decl) return;

      let resolvedDecl = decl;
      if (Node.isImportSpecifier(decl) || Node.isImportClause(decl)) {
        const aliased = sym.getAliasedSymbol && sym.getAliasedSymbol();
        if (aliased) {
          const d = aliased.getDeclarations()[0];
          if (d) resolvedDecl = d;
        }
      }

      entries.push({
        method: method.toUpperCase(),
        routePath: routePath || '?',
        routeFile: rel,
        handlerName: handlerArg.getText(),
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

function buildGraph({ project, serverRoot, git, entries, fileHunks, maxDepth }) {
  const nodes = new Map();
  const edges = [];
  const edgeKey = (f, t) => `${f}→${t}`;
  const edgeIdx = new Map();

  function isInProject(decl) {
    const filePath = decl.getSourceFile().getFilePath();
    return filePath.startsWith(serverRoot + path.sep) && !filePath.includes(`${path.sep}node_modules${path.sep}`);
  }

  function addNode(decl, { isEntry = false, isExternal = false, route = null } = {}) {
    const id = declId(decl, project);
    if (nodes.has(id)) {
      const n = nodes.get(id);
      if (isEntry) n.isEntry = true;
      if (route && !n.routes.includes(route)) n.routes.push(route);
      return n;
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
      created: ts.created,
      updated: ts.updated,
      commits: ts.commits,
    };
    nodes.set(id, rec);
    return rec;
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
            created: null,
            updated: null,
            commits: [],
          });
        }
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
  return out.replace(/\.ts$/, '');
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
  const { prNum, title, base, entries, nodes, edges } = meta;
  const lines = [];
  lines.push(`pr: "${prNum}"`);
  lines.push(`title: ${JSON.stringify(title)}`);
  lines.push(`base_branch: "${base}"`);
  lines.push(`generated_at: "${new Date().toISOString()}"`);
  lines.push(`tool: agent-pintu v0.1.0`);
  lines.push('entry_routes:');
  for (const e of entries) {
    lines.push(`  - method: ${e.method}`);
    lines.push(`    path: "${e.fullPath}"`);
    lines.push(`    handler: "${e.handlerName}"`);
    lines.push(`    route_file: "${e.routeFile}"`);
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

function renderMarkdown({ title, base, nodes, edges, perEntry, project, serverRoot }) {
  let md = '';
  md += `# ${title}\n\n`;
  md += `**Base:** \`${base}\` • **Generated:** ${new Date().toISOString()} • **Nodes:** ${nodes.size} • **Edges:** ${edges.length}\n\n`;
  md += `> Orange = touched by this PR. Blue = route entry. Gray = external/library.\n\n`;

  md += `## Combined call graph\n\n`;
  md += mermaid(nodes, edges, null, project, serverRoot) + '\n\n';

  for (const pe of perEntry) {
    md += `## ${pe.method} ${pe.displayPath || pe.fullPath}\n\n`;
    md += `Handler: \`${pe.handlerName}\` — \`${shortFile(pe.routeFile, project, serverRoot)}\`\n\n`;
    const reachable = reachableFrom([pe.entryId], edges);
    md += mermaid(nodes, edges, reachable, project, serverRoot) + '\n\n';
    md += tableFor(pe.entryId, edges, nodes, project, serverRoot) + '\n\n';
  }

  const reachedAny = new Set();
  for (const pe of perEntry) for (const id of reachableFrom([pe.entryId], edges)) reachedAny.add(id);
  const orphans = [...nodes.values()].filter((n) => n.touched && !reachedAny.has(n.id));
  if (orphans.length) {
    md += `## Touched code not reached from any traced route\n\n`;
    md += `These functions were modified by this PR but aren't reachable from the route entries above — likely cron jobs, CLI scripts, admin-only paths, or callers from outside the server root. Consider tracing from a different entry point.\n\n`;
    md += `| Function | File:Line | Last updated |\n| --- | --- | --- |\n`;
    for (const n of orphans) {
      md += `| \`${n.name}\` | \`${shortFile(n.file, project, serverRoot)}:${n.line}\` | ${n.updated ? n.updated.slice(0, 10) : '—'} |\n`;
    }
    md += '\n';
  }
  return md;
}

module.exports = { runTrace };
