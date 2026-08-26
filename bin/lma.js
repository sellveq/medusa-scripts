#!/usr/bin/env node
// find the project root, dispatch to the bash engine in assets/
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const config = require('../lib/config.js')
const paths = require('../lib/paths.js')
const secrets = require('../lib/secrets.js')

const ASSETS = path.join(__dirname, '..', 'assets')
const TEMPLATES = path.join(__dirname, '..', 'templates')

const render = (tpl, vars) =>
    fs.readFileSync(path.join(TEMPLATES, tpl), 'utf8')
        .replace(/__([A-Z_]+)__/g, (_, k) => vars[k] ?? `__${k}__`)

const SCRIPTS = {
    lma: 'lma',
    start: 'lma start', stop: 'lma stop', restart: 'lma restart',
    destroy: 'lma destroy', status: 'lma status', logs: 'lma logs',
    psql: 'lma psql', redis: 'lma redis',
    'import-db': 'lma import-db', 'dump-db': 'lma dump-db', 'reset-db': 'lma reset-db',
    migrate: 'lma migrate', 'seed-admin': 'lma seed-admin',
    admin: 'lma admin', 'show-env': 'lma show-env',
    tunnel: 'lma tunnel', 'tunnel:setup': 'lma tunnel setup',
    'tunnel:quick': 'lma tunnel quick', 'tunnel:start': 'lma tunnel start',
    'tunnel:stop': 'lma tunnel stop', 'tunnel:status': 'lma tunnel status',
    'tunnel:logs': 'lma tunnel logs',
}

// merge npm aliases into package.json; true when `npm run <alias>` works
const addScripts = (cwd, wanted) => {
    const pkgPath = path.join(cwd, 'package.json')
    const manual = Object.entries(wanted).map(([k, v]) => `    "${k}": "${v}"`).join(',\n')
    if (!fs.existsSync(pkgPath)) {
        console.log(`  no package.json here; add these scripts yourself:\n${manual}`)
        return false
    }
    let raw, pkg
    try {
        raw = fs.readFileSync(pkgPath, 'utf8')
        pkg = JSON.parse(raw)
    } catch (e) {
        console.log(`  skipped   package.json (${e.message}); add these scripts yourself:\n${manual}`)
        return false
    }
    const indent = (raw.match(/^([ \t]+)"/m) || [, '  '])[1]
    const eof = raw.endsWith('\n') ? '\n' : ''
    const existing = pkg.scripts || {}
    const fresh = {}
    const added = []
    const kept = []
    for (const [k, v] of Object.entries(wanted)) {
        if (existing[k] === v) continue
        if (existing[k]) kept.push(k)
        else { fresh[k] = v; added.push(k) }
    }
    if (!added.length) {
        console.log(`  kept      package.json scripts${kept.length ? ` (yours win: ${kept.join(', ')})` : ''}`)
        return true
    }
    pkg.scripts = { ...fresh, ...existing }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + eof)
    console.log(`  updated   package.json (+${added.join(', ')})${kept.length ? ` (yours win: ${kept.join(', ')})` : ''}`)
    return true
}

const init = (cwd, args) => {
    const project = config.slug(path.basename(cwd)) || 'app'
    const vars = { PROJECT: project }
    const name = config.configName(cwd)
    const existing = config.configPath(cwd)
    console.log(`Initializing lma for '${project}' in ${cwd}`)
    if (existing) {
        console.log(`  kept      ${path.relative(cwd, existing)}`)
    } else {
        fs.writeFileSync(path.join(cwd, name), render('lma.js.tpl', vars))
        console.log(`  created   ${name}${name === 'lma.cjs' ? '  (.cjs: this project is "type": "module")' : ''}`)
    }

    paths.ensure(cwd)
    const { values } = secrets.ensure(cwd)
    console.log(`  created   ${paths.STATE}/  (ports, secrets, dumps, logs; git-ignored)`)

    // --scripts adds an alias per command, --no-scripts none
    const wired = !args.includes('--no-scripts') &&
        addScripts(cwd, args.includes('--scripts') ? SCRIPTS : { lma: 'lma' })
    const run = wired ? 'npm run lma start' : 'npx lma start'
    console.log(`\nAdmin login (generated, local only): admin@${project}.local / ${values.LMA_ADMIN_PASSWORD}`)
    console.log(`Next: edit ${existing ? path.basename(existing) : name}, then run: ${run}`)
}

// alias → engine command
const ALIAS = {
    'import-db': ['local.sh', 'db:import'],
    'dump-db': ['local.sh', 'db:dump'],
    'reset-db': ['local.sh', 'db:reset'],
    redis: ['local.sh', 'redis-cli'],
}

const main = () => {
    const [cmd = 'help', ...args] = process.argv.slice(2)

    if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
        const { name, version } = require('../package.json')
        return console.log(`${name} ${version} (node ${process.versions.node})`)
    }

    if (cmd === 'init') return init(process.cwd(), args)

    const isHelp = cmd === 'help' || cmd === '-h' || cmd === '--help'
    const root = config.findRoot(process.cwd())
    if (!root && !isHelp) {
        console.error(`No ${config.NAMES.join(' or ')} here or in any parent directory. Run 'lma init' in your project root first.`)
        process.exit(1)
    }

    if (cmd === 'ports') {
        return require('../lib/ports.js')
            .resolve(root, { reset: args.includes('--reset') })
            .then(({ ports, bases, cachePath }) => {
                for (const [svc, p] of Object.entries(ports)) {
                    const moved = p !== bases[svc] ? `  (preferred ${bases[svc]} busy)` : ''
                    console.log(`  ${svc.padEnd(12)} ${p}${moved}`)
                }
                console.log(`\ncache: ${cachePath}`)
            })
            .catch((e) => { console.error(e.message); process.exit(1) })
    }

    let script, engineArgs
    if (cmd === 'tunnel') {
        script = 'tunnel.sh'
        engineArgs = args.length ? args : ['help']
    } else if (ALIAS[cmd]) {
        ;[script, ...engineArgs] = ALIAS[cmd]
        engineArgs = [...engineArgs, ...args]
    } else {
        script = 'local.sh'
        engineArgs = [cmd, ...args]
    }

    const env = { ...process.env, LMA_ASSETS: ASSETS }
    if (root) env.LMA_ROOT = root
    else delete env.LMA_ROOT

    const r = spawnSync('bash', [path.join(ASSETS, script), ...engineArgs], {
        stdio: 'inherit',
        cwd: root || process.cwd(),
        env,
    })
    process.exit(r.status ?? 1)
}

main()
