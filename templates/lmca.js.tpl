module.exports = {
    project: '__PROJECT__',
    services: {
        postgres: {
            user: '__PROJECT__',
            password: '__PROJECT__',
            database: '__PROJECT__',
        },
    },
    admin: {
        email: 'admin@__PROJECT__.local',
        password: 'medusa123',
    },
    apps: {
        backend: {
            dir: 'apps/backend',
        },
        storefront: {
            dir: 'apps/storefront',
        },
    },
    proxy: {
        domain: 'localhost',
    },
    tunnel: {
        name: '__PROJECT__',
        hostnames: {
            storefront: 'example.com',
            backend: 'api.example.com',
        },
    },
}
