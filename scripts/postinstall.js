// Adds the `"lma": "lma"` npm alias to the consuming project on install.
// Never overwrites, never fails the install.
const fs = require('node:fs')
const path = require('node:path')

try {
    const target = process.env.INIT_CWD // where `npm install` was invoked
    if (!target) process.exit(0)
    const pkgPath = path.join(target, 'package.json')
    if (!fs.existsSync(pkgPath)) process.exit(0)

    const raw = fs.readFileSync(pkgPath, 'utf8')
    const pkg = JSON.parse(raw)
    if (['medusa-scripts', '@selveq/medusa-scripts'].includes(pkg.name)) process.exit(0)
    if (pkg.scripts && pkg.scripts.lma) process.exit(0)

    // keep the file's own indentation and trailing-newline style
    const indent = (raw.match(/^([ \t]+)"/m) || [, '  '])[1]
    const eof = raw.endsWith('\n') ? '\n' : ''
    pkg.scripts = { lma: 'lma', ...(pkg.scripts || {}) }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + eof)
    console.log('@selveq/medusa-scripts: added "lma" script — use `npm run lma <command>`')
} catch { /* convenience only */ }
