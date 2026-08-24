// loads the project config for every reader; ESM projects must name it lma.cjs
const fs = require('node:fs')
const path = require('node:path')

const NAMES = ['lma.js', 'lma.cjs']

const findRoot = (from) => {
    let dir = path.resolve(from)
    for (;;) {
        if (NAMES.some((n) => fs.existsSync(path.join(dir, n)))) return dir
        const parent = path.dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

// "type" from the nearest package.json at or above dir
const packageType = (dir) => {
    let d = path.resolve(dir)
    for (;;) {
        const p = path.join(d, 'package.json')
        if (fs.existsSync(p)) {
            try { return JSON.parse(fs.readFileSync(p, 'utf8')).type || 'commonjs' }
            catch { return 'commonjs' }
        }
        const parent = path.dirname(d)
        if (parent === d) return 'commonjs'
        d = parent
    }
}

// the filename `lma init` should write in dir
const configName = (dir) => (packageType(dir) === 'module' ? 'lma.cjs' : 'lma.js')

// prefer the extension matching the module type so a leftover lma.js cannot shadow lma.cjs
const configPath = (root) => {
    const preferred = configName(root)
    for (const n of [preferred, ...NAMES.filter((n) => n !== preferred)]) {
        const p = path.join(root, n)
        if (fs.existsSync(p)) return p
    }
    return null
}

const load = (root) => {
    const file = configPath(root)
    if (!file) throw new Error(`no ${NAMES.join(' or ')} in ${root}; run 'lma init' first`)
    if (file.endsWith('.js') && packageType(root) === 'module') {
        const target = `${file.slice(0, -3)}.cjs`
        // .cjs is absent when we get here; never suggest a mv that would overwrite
        throw new Error(
            `${file} is CommonJS but this project is "type": "module", so it cannot be loaded.\n` +
            (fs.existsSync(target)
                ? `Delete it; ${path.basename(target)} is the config in use.`
                : `Rename it to lma.cjs:  mv ${file} ${target}`)
        )
    }
    const cfg = require(file)
    if (!cfg || typeof cfg !== 'object' || Object.keys(cfg).length === 0) {
        throw new Error(`${file} exported no config; it must be CommonJS: module.exports = { ... }`)
    }
    return cfg
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// the single project name used for containers, volumes and the DB; always slugged or compose splits the stack
const project = (root, cfg = {}) =>
    slug(cfg.project || '') || slug(path.basename(path.resolve(root))) || 'app'

module.exports = { NAMES, findRoot, configPath, packageType, configName, load, slug, project }
