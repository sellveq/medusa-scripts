// infra images pinned by tag and index digest
// bump with: docker buildx imagetools inspect <image>:<tag> --raw | shasum -a 256
const PINNED = {
    postgres: {
        ref: 'postgres:16.15-alpine',
        digest: 'sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
    },
    redis: {
        ref: 'redis:7.4.11-alpine',
        digest: 'sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf',
    },
    proxy: {
        ref: 'nginx:1.31.4-alpine',
        digest: 'sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913',
    },
}

const pinned = (service) => {
    const p = PINNED[service]
    if (!p) throw new Error(`unknown service '${service}'`)
    return `${p.ref}@${p.digest}`
}

const validate = (service, image) => {
    const problems = []
    const ref = String(image)
    const [name] = ref.split('@')
    const tag = name.includes('/') ? name.slice(name.lastIndexOf('/')).split(':')[1] : name.split(':')[1]
    if (!tag) problems.push(`'${ref}' has no tag; pin one (e.g. ${PINNED[service] ? PINNED[service].ref : 'name:1.2.3'})`)
    else if (tag === 'latest') problems.push(`'${ref}' is pinned to :latest, which moves under you`)
    return problems
}

const resolve = (service, override, warn = () => {}) => {
    if (!override) return pinned(service)
    for (const p of validate(service, override)) warn(`${service}: ${p}`)
    return String(override)
}

const all = (cfg = {}, warn = () => {}) => {
    const s = cfg.services || {}
    const p = cfg.proxy || {}
    return {
        postgres: resolve('postgres', (s.postgres || {}).image, warn),
        redis: resolve('redis', (s.redis || {}).image, warn),
        proxy: resolve('proxy', p.image, warn),
    }
}

module.exports = { PINNED, pinned, validate, resolve, all }
