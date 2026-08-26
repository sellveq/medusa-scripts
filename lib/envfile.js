// KEY=value reader, matching dotenv on quotes and trailing comments
const fs = require('node:fs')

const parse = (text) => {
    const out = {}
    for (const line of String(text).split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
        if (!m) continue
        let v = m[2].trim()
        const quoted = v.match(/^(['"])([\s\S]*)\1\s*$/)
        if (quoted) v = quoted[2]
        else v = v.replace(/\s+#.*$/, '').trim()
        out[m[1]] = v
    }
    return out
}

const read = (file) => {
    try { return parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

module.exports = { parse, read }
