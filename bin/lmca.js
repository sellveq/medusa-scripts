#!/usr/bin/env node
// lmca — local dev CLI. Finds the project root (nearest lmca.js upward) and
// dispatches to the bash engine in assets/ with LMCA_ROOT/LMCA_ASSETS set.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ASSETS = path.join(__dirname, '..', 'assets')
const TEMPLATES = path.join(__dirname, '..', 'templates')

const findRoot = (from) => {
    let dir = from
    for (;;) {
        if (fs.existsSync(path.join(dir, 'lmca.js'))) return dir
        const parent = path.dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

const render = (tpl, vars) =>
    fs.readFileSync(path.join(TEMPLATES, tpl), 'utf8')
        .replace(/__([A-Z_]+)__/g, (_, k) => vars[k] ?? `__${k}__`)

const SCRIPTS = {
    start: 'lmca start', stop: 'lmca stop', restart: 'lmca restart',
    destroy: 'lmca destroy', status: 'lmca status', logs: 'lmca logs',
    psql: 'lmca psql', redis: 'lmca redis',
    'import-db': 'lmca import-db', 'dump-db': 'lmca dump-db', 'reset-db': 'lmca reset-db',
    migrate: 'lmca migrate', 'show-env': 'lmca show-env', lmca: 'lmca',
    tunnel: 'lmca tunnel', 'tunnel:setup': 'lmca tunnel setup',
    'tunnel:quick': 'lmca tunnel quick', 'tunnel:start': 'lmca tunnel start',
    'tunnel:stop': 'lmca tunnel stop', 'tunnel:status': 'lmca tunnel status',
    'tunnel:logs': 'lmca tunnel logs',
}

const init = (cwd, args) => {
    const project = path.basename(cwd).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'app'
    const vars = { PROJECT: project }
    const writeIfMissing = (file, content) => {
        if (fs.existsSync(file)) return console.log(`  kept      ${path.relative(cwd, file)}`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, content)
        console.log(`  created   ${path.relative(cwd, file)}`)
    }
    console.log(`Initializing lmca for '${project}' in ${cwd}`)
    writeIfMissing(path.join(cwd, 'lmca.js'), render('lmca.js.tpl', vars))

    if (args.includes('--scripts')) {
        const pkgPath = path.join(cwd, 'package.json')
        if (!fs.existsSync(pkgPath)) {
            console.log('  no package.json here — add the scripts manually (see below)')
        } else {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
            pkg.scripts = pkg.scripts || {}
            const skipped = []
            for (const [k, v] of Object.entries(SCRIPTS)) {
                if (pkg.scripts[k] && pkg.scripts[k] !== v) skipped.push(k)
                else pkg.scripts[k] = v
            }
            fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
            console.log(`  updated   package.json scripts${skipped.length ? ` (kept existing: ${skipped.join(', ')})` : ''}`)
        }
    }
    console.log('\nNext: edit lmca.js, then run: lmca start')
}

// alias -> engine command
const ALIAS = {
    'import-db': ['local.sh', 'db:import'],
    'dump-db': ['local.sh', 'db:dump'],
    'reset-db': ['local.sh', 'db:reset'],
    redis: ['local.sh', 'redis-cli'],
}

const main = () => {
    const [cmd = 'help', ...args] = process.argv.slice(2)

    if (cmd === 'init') return init(process.cwd(), args)

    const root = findRoot(process.cwd())
    if (!root) {
        console.error("No lmca.js found here or in any parent directory. Run 'lmca init' in your project root first.")
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

    const r = spawnSync('bash', [path.join(ASSETS, script), ...engineArgs], {
        stdio: 'inherit',
        cwd: root,
        env: { ...process.env, LMCA_ROOT: root, LMCA_ASSETS: ASSETS },
    })
    process.exit(r.status ?? 1)
}

main()
