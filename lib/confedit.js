// patches tunnel hostnames into the hand-edited config, reverting if they do not read back
const fs = require('node:fs')
const path = require('node:path')
const config = require('./config.js')

// a name cloudflare can resolve; a trailing numeric label means it is an address
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z0-9-]*[a-z][a-z0-9-]*$/

const close = (src, open) => {
    let depth = 0
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}' && --depth === 0) return i
    }
    return -1
}

const openOf = (src, key, from, to) => {
    const m = new RegExp(`(?:^|[\\s{,])["']?${key}["']?\\s*:\\s*\\{`).exec(src.slice(from, to))
    return m ? from + m.index + m[0].length - 1 : -1
}

const literal = (map, pad, unit) => {
    const rows = Object.entries(map).map(([k, v]) => `${pad}${unit}${k}: '${v}',`)
    return `${pad}hostnames: {\n${rows.join('\n')}\n${pad}},`
}

const setHostnames = (root, add) => {
    for (const [app, host] of Object.entries(add)) {
        if (!HOST.test(host)) throw new Error(`'${host}' is not a hostname (${app})`)
    }
    const file = config.configPath(root)
    if (!file) throw new Error(`no ${config.NAMES.join(' or ')} in ${root}`)
    const before = fs.readFileSync(file, 'utf8')
    const merged = { ...((config.load(root).tunnel || {}).hostnames || {}), ...add }
    const unit = (before.match(/\n([ \t]+)\S/) || [, '    '])[1]

    let out
    const tunnel = openOf(before, 'tunnel', 0, before.length)
    if (tunnel === -1) {
        const start = before.indexOf('{')
        const end = close(before, start)
        if (end === -1) throw new Error('no object literal to add tunnel.hostnames to')
        const block = `${unit}tunnel: {\n${literal(merged, unit + unit, unit)}\n${unit}},\n`
        out = before.slice(0, end) + (before[end - 1] === '\n' ? '' : '\n') + block + before.slice(end)
    } else {
        const end = close(before, tunnel)
        const hostnames = openOf(before, 'hostnames', tunnel + 1, end)
        if (hostnames === -1) {
            out = `${before.slice(0, tunnel + 1)}\n${literal(merged, unit + unit, unit)}${before.slice(tunnel + 1)}`
        } else {
            const line = before.lastIndexOf('\n', hostnames) + 1
            const pad = before.slice(line).match(/^[ \t]*/)[0]
            let after = close(before, hostnames) + 1
            if (before[after] === ',') after++
            out = before.slice(0, line) + literal(merged, pad, unit) + before.slice(after)
        }
    }

    fs.writeFileSync(file, out)
    try {
        delete require.cache[require.resolve(file)]
        const got = (config.load(root).tunnel || {}).hostnames || {}
        for (const [k, v] of Object.entries(merged)) {
            if (got[k] !== v) throw new Error(`${k} did not read back`)
        }
    } catch (e) {
        fs.writeFileSync(file, before)
        throw new Error(`${path.basename(file)} was left unchanged: ${e.message}`)
    }
    return { file, hostnames: merged }
}

module.exports = { HOST, setHostnames }
