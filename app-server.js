const fs = require('fs');
const url = require('url');
const logu = require('@gridspace/log-util').default;
const http = require('http');
const https = require('https');
const Connect = require('connect');
const WebSocket = require('ws');
const Compression = require('compression');
const ServeStatic = require('serve-static');
const exits = [];
const moddirs = {};
const chain = Connect().use(Compression()).use(setup);
const ipLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const env = {};
let datadir;
let logdir;
let logger;

Array.prototype.contains = function(v) {
    return this.indexOf(v) >= 0;
};

Array.prototype.appendAll = function(a) {
    this.push.apply(this,a);
    return this;
};

function log() {
    logger.log('[appserver]',...arguments);
}

function lastmod(path) {
    try {
        return fs.statSync(path).mtime.getTime();
    } catch (e) {
        return 0;
    }
}

function mkdir(path) {
    let root = "";
    path.split("/").forEach(dir => {
        root = root ? `${root}/${dir}` : dir;
        lastmod(root) || fs.mkdirSync(root);
    });
    return root;
}

function isdir(path) {
    try {
        return fs.statSync(path).isDirectory();
    } catch (e) {
        return false;
    }
}

function isfile(path) {
    try {
        return fs.statSync(path).isFile();
    } catch (e) {
        return false;
    }
}

function noCache(res) {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.setHeader("Expires", "0");
}

function redirect(res, url, type) {
console.log('redirect', url);
    res.writeHead(type || 307, { "Location": url });
    res.end();
}

function reply404(req, res) {
    logger.emit([
        '404',
        req.url,
        req.socket.remoteAddress,
        req.headers
    ]);
    res.writeHead(404);
    res.end("[404]");
}

function isNotLocal(ip) {
    return ipLocal.contains(ip) ? null : ip;
}

function remoteIP(req) {
    let fwd = req.headers['x-forwarded-for'],
        sra = req.socket.remoteAddress,
        cra = req.connection.remoteAddress,
        ip = isNotLocal(fwd) || sra || cra || '',
        ipa = ip.split(',');
    if (ip === '' || ipa.length > 1) {
        helper.log({remote:ipa, fwd, sra, cra});
    }
    return ipa[0];
}

function setup(req, res, next) {
    const parsed = url.parse(req.url, true);

    req.app = req.gs = {
        ip: remoteIP(req),
        path: parsed.pathname,
        query: parsed.query,
        params: new url.URLSearchParams(parsed.query)
    };

    req.app.params.getBoolean = (key) => {
        let value = req.app.params.get(key);
        if (value === 'true' || value === true) return true;
        if (value === 'false' || value === false) return false;
        return undefined;
    }

    // logger.emit([
    //     req.method,
    //     req.headers['host'] || '',
    //     req.url,
    //     req.socket.remoteAddress,
    //     req.headers['origin'] || '',
    //     req.headers['user-agent'] || ''
    // ]);

    next();
}

function decodePost(req, res, next) {
    if (req.method === 'POST') {
        let content = '';
        req
            .on('data', data => {
                content += data.toString();
            })
            .on('end', () => {
                req.app.post = content;
                next();
            });
    } else {
        next();
    }
}

function handleSync(path, fn, opt) {
    return (req, res, next) => {
        let method = (opt ? opt.method : "GET") || "GET";
        if (req.method !== method) {
            return next();
        }
        if (req.app.path !== path) {
            return next();
        }
        try {
            const out = fn(req.app);
            if (typeof(out) == 'string') {
                res.end(out);
            } else {
                res.end(JSON.stringify(out));
            }
        } catch (error) {
            log({path, error});
        }
    };
}

function handleAsync(path, fn, opt) {
    return (req, res, next) => {
        let method = (opt ? opt.method : "GET") || "GET";
        if (req.method !== method) {
            return next();
        }
        if (req.app.path !== path) {
            return next();
        }
        try {
            fn(req.app, (out) => {
                if (typeof(out) == 'string') {
                    res.end(out);
                } else {
                    res.end(JSON.stringify(out));
                }
            });
        } catch (error) {
            log({path, error});
        }
    };
}

function handleStatic(prefix, path, options) {
    let handler = ServeStatic(path, options);
    return function(req, res, next) {
        if (prefix && req.url.indexOf(prefix) === 0) {
            let nurl = req.url.substring(prefix.length);
            if (nurl === '') {
                nurl = prefix;
            } else if (nurl.charAt(0) !== '/') {
                nurl = `/${nurl}`;
            }
            req.url = nurl;
            handler(req, res, next);
        } else {
            next();
        }
    };
}

function updateApps(dir) {
    if (!isdir(dir)) {
        log(`invalid apps directory "${dir}"`);
        return process.exit(1);
    }

    fs.readdirSync(dir).forEach(file => {
        let path = `${dir}/${file}`;
        if (isfile(`${path}/app.json`)) {
            updateApp(path);
        }
    });
}

function updateApp(dir, force) {
    try {
        let dirs = moddirs;
        let orec = dirs[dir];
        let path = `${dir}/app.json`;
        let tmod = lastmod(path);
        if (!force && orec && orec.tmod >= tmod) return;

        let meta = JSON.parse(fs.readFileSync(path));
        let name = meta.name || dir;
        let main = meta.main || "app.js";
        let host = meta.host || [ "*" ];

        if (name === "server") {
            throw `invalid name (reserved): ${name}`;
        }
        if (!isfile(`${dir}/${main}`)) {
            if (orec) orec.disabled = true;
            throw `invalid main: ${path}`;
        }
        if (typeof(host) === 'string') {
            host = [ host ];
        }
        if (orec && orec.unload) try {
            orec.unload();
        } catch (error) {
            log({mod_unload: name, error});
        }

        let mapp = require.resolve(`./${dir}/${main}`);
        delete require.cache[mapp];
        let init = require(mapp);
        if (typeof(init) !== 'function') {
            if (orec) orec.disabled = true;
            throw `invalid app init function: ${path}`;
        }

        let app = Connect();
        let nrec = {
            app,
            path,
            tmod,
            host,
            wss: {}
        };
        let lpre = `[${name}]`;

        init({
            app, // middleware connector
            dir, // module directory
            env, // app server runtime environment
            add: (fn) => { app.use(fn) },
            log: {
                new: (opt, exit) => {
                    if (opt.dir) {
                        if (opt.dir.indexOf(".log-") == 0) {
                            opt.dir = opt.dir.substring(5);
                        }
                        opt.dir = `${logdir}/${name}/${opt.dir}`;
                    } else {
                        opt.dir = `${logdir}/${name}`;
                    }
                    return logu.open(opt, exit);
                },
                log: function() { logger.log(lpre, ...arguments) },
                emit: function() { logger.emit(lpre, ...arguments) },
                close: () => {}
            },
            meta: meta,
            util: {
                mkdir,
                lastmod,
                datadir: (dn) => { return mkdir(`${datadir}/${name}/${dn}`) }
            },
            http: {
                noCache,
                redirect,
                reply404,
                decodePost
            },
            reload: () => {
                updateApp(dir, true);
            },
            // pre=path prefix, path=relative to module root
            static: (pre, path) => {
                nrec.app.use(handleStatic(pre, dir + "/" + path));
            },
            async: (path, fn) => {
                nrec.app.use(handleAsync(path, fn));
            },
            sync: (path, fn) => {
                nrec.app.use(handleSync(path, fn));
            },
            wss: (path, fn) => {
                nrec.wss[path] = fn;
            },
            on: {
                reload: (fn) => { nrec.unload = fn },
                test: (fn) => { nrec.test = fn },
                exit: (fn) => { exits.push(fn) }
            }
        });

        if (orec) {
            nrec.handler = orec.handler;
        } else {
            nrec.handler = function(req, res, next) {
                let mod = dirs[dir];
                if (!mod || mod.disabled) {
                    return next();
                }
                let host = req.headers.host;
                if (mod.host.indexOf(host) >= 0 || mod.host.indexOf('*') >= 0) {
                    if (!mod.test || mod.test(req)) {
                        return mod.app.handle(req, res, next);
                    }
                }
                next();
            };
            chain.use(nrec.handler);
        }

        if (typeof(meta.static) === 'object') {
            Object.entries(meta.static).forEach(entry => {
                let [pre, path] = entry;
                nrec.app.use(handleStatic(pre, dir + "/" + path));
            });
        }

        dirs[dir] = nrec;
        log(`${orec ? 'reinitialized' : 'initialized'} ${name} from ${dir}`);
    } catch (e) {
        log(`invalid app.json for ${dir}`);
        console.log(e);
    }
}

function addWSS(server) {
    const wss = new WebSocket.Server({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        let fn = undefined;
        let host = request.headers.host;
        Object.values(moddirs).forEach(rec => {
            if (rec.host.indexOf(host) >= 0 || rec.host.indexOf('*') >= 0) {
                if (!rec.test || rec.test(request)) {
                    fn = fn || rec.wss[request.url];
                }
            }
        });
        if (!fn) {
            socket.destroy();
        } else {
            wss.handleUpgrade(request, socket, head, ws => {
              fn(ws, request);
            });
        }
    });
}

function init(options) {
    let ports = [];
    let opts = options || { };
    let apps = opts.apps || "apps";
    let logs = opts.logs || "logs";
    let data = opts.data || "data";
    let port = opts.port || 8080;
    let portsec = opts.portsec;

    datadir = data;
    logdir = logs;
    logger = logu.open({dir: `${logs}/server`}, exits);

    if (port) {
        ports.push(port);
        addWSS(http.createServer(chain).listen(port));
    }

    if (portsec) {
        ports.push(portsec);
        const dir = opts.certdir || ".";
        const key = opts.pemkey || "key.pem";
        const cert = opts.pemcert || "cert.pem";
        addWSS(https.createServer({
            key: fs.readFileSync(dir + '/' + key),
            cert: fs.readFileSync(dir + '/' + cert)
        }, chain).listen(opts.portsec));
    }

    Object.assign(env, opts.env);

    updateApps(apps);
    setInterval(() => { updateApps(apps)}, 5000);

    if (!opts.managed) {
        let startTime = Date.now();
        let procExit = false;

        function processExit(code) {
            if (procExit) {
                return;
            }
            procExit = true;
            log({proc_exit: code, registered: exits.length, uptime: Date.now() - startTime});
            while (exits.length) {
                try {
                    exits.shift()(code);
                } catch (e) {
                    log({on_exit_fail: e});
                }
            }
            setTimeout(() => {
                process.exit();
            }, 500);
        }

        process.on('beforeExit', processExit);
        process.on('exit', processExit);

        process.on('SIGINT', function(sig, code) {
            log({exit: code, signal: sig});
            processExit(code);
        });

        process.on('SIGHUP', function(sig, code) {
            log({exit: code, signal: sig});
            processExit(code);
        });

        process.on('unhandledRejection', (reason, p) => {
            log({unhandled_rejection: reason, promise: p});
        });

        process.on('uncaughtException', (err) => {
            log({uncaught_exception: err});
        });
    }

    log(`app-server running: ports=[${ports}] apps=[${apps}] data=[${data}] logs=[${logs}]`);
}

if (!module.parent) {
    let args = require('minimist')(process.argv.slice(2));
    init({
        env: args,
        logs: args.logs,
        apps: args.apps,
        data: args.data,
        port: args.port || args.http,
        portsec: args.https
    });
} else {
    module.exports = init;
}
