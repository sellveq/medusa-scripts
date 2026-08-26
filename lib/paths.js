// durable state at the project root, regenerable state in the install cache
const fs = require('node:fs')
const path = require('node:path')

const STATE = '.local-medusa-app'
const CACHE = path.join('node_modules', '.local-medusa-app-cache')

const stateDir = (root) => path.join(path.resolve(root), STATE)
const cacheDir = (root) => path.join(path.resolve(root), CACHE)

const ensure = (root) => {
    const state = stateDir(root)
    fs.mkdirSync(state, { recursive: true })
    fs.mkdirSync(cacheDir(root), { recursive: true })
    const ignore = path.join(state, '.gitignore')
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
    return state
}

const sub = (root, ...parts) => path.join(stateDir(root), ...parts)

module.exports = { STATE, CACHE, stateDir, cacheDir, ensure, sub }
