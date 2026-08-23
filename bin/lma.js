#!/usr/bin/env node
// lma — local dev CLI. Finds the project root (nearest lma.js upward) and
// dispatches to the bash engine in assets/ with LMA_ROOT/LMA_ASSETS set.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ASSETS = path.join(__dirname, '..', 'assets')
const TEMPLATES = path.join(__dirname, '..', 'templates')

const findRoot = (from) => {
    let dir = from
    for (;;) {
        if (fs.existsSync(path.join(dir, 'lma.js'))) return dir
        const parent = path.dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

const render = (tpl, vars) =>
    fs.readFileSync(path.join(TEMPLATES, tpl), 'utf8')
        .replace(/__([A-Z_]+)__/g, (_, k) => vars[k] ?? `__${k}__`)

const SCRIPTS = {
    start: 'lma start', stop: 'lma stop', restart: 'lma restart',
    destroy: 'lma destroy', status: 'lma status', logs: 'lma logs',
    psql: 'lma psql', redis: 'lma redis',
    'import-db': 'lma import-db', 'dump-db': 'lma dump-db', 'reset-db': 'lma reset-db',
    migrate: 'lma migrate', 'show-env': 'lma show-env', lma: 'lma',
    tunnel: 'lma tunnel', 'tunnel:setup': 'lma tunnel setup',
    'tunnel:quick': 'lma tunnel quick', 'tunnel:start': 'lma tunnel start',
    'tunnel:stop': 'lma tunnel stop', 'tunnel:status': 'lma tunnel status',
    'tunnel:logs': 'lma tunnel logs',
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
    console.log(`Initializing lma for '${project}' in ${cwd}`)
    writeIfMissing(path.join(cwd, 'lma.js'), render('lma.js.tpl', vars))

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
    console.log('\nNext: edit lma.js, then run: lma start')
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
        console.error("No lma.js found here or in any parent directory. Run 'lma init' in your project root first.")
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
        env: { ...process.env, LMA_ROOT: root, LMA_ASSETS: ASSETS },
    })
    process.exit(r.status ?? 1)
}

main()
