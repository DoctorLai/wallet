/* eslint-disable arrow-parens */
/* eslint-disable no-plusplus */
/* eslint-disable space-before-function-paren */
/* eslint-disable prefer-arrow-callback */
/* eslint-disable no-unused-vars */
/* eslint-disable no-bitwise */
/* eslint-disable require-yield */
/* eslint-disable generator-star-spacing */
/* eslint-disable import/no-dynamic-require */
/* eslint-disable global-require */
/* eslint-disable import/first */
import path from 'path';
import Koa from 'koa';
import mount from 'koa-mount';
import helmet from 'koa-helmet';
import koa_logger from 'koa-logger';
import requestTime from './requesttimings';
import StatsLoggerClient from './utils/StatsLoggerClient';
import { SteemMarket } from './utils/SteemMarket';
import hardwareStats from './hardwarestats';
import cluster from 'cluster';
import os from 'os';
import prod_logger from './prod_logger';
import favicon from 'koa-favicon';
import staticCache from 'koa-static-cache';
import useRedirects from './redirects';
import useGeneralApi from './api/general';
import useAccountRecoveryApi from './api/account_recovery';
import useEnterAndConfirmEmailPages from './sign_up_pages/enter_confirm_email';
import useEnterAndConfirmMobilePages from './sign_up_pages/enter_confirm_mobile';
import isBot from 'koa-isbot';
import session from '@steem/crypto-session';
import csrf from 'koa-csrf';
import minimist from 'minimist';
import config from 'config';
import { routeRegex } from 'app/ResolveRoute';
import secureRandom from 'secure-random';
import userIllegalContent from 'app/utils/userIllegalContent';
import koaLocale from 'koa-locale';
import { getSupportedLocales } from './utils/misc';

if (cluster.isMaster) console.log('application server starting, please wait.');

// import uploadImage from 'server/upload-image' //medium-editor

const app = new Koa();
app.name = 'Steemit app';
const env = process.env.NODE_ENV || 'development';
// cache of a thousand days
const cacheOpts = { maxAge: 86400000, gzip: true, buffer: true };

// Serve static assets without fanfare
app.use(
    favicon(path.join(__dirname, '../app/assets/images/favicons/favicon.ico'))
);
app.use(
    mount(
        '/favicons',
        staticCache(
            path.join(__dirname, '../app/assets/images/favicons'),
            cacheOpts
        )
    )
);
app.use(
    mount(
        '/images',
        staticCache(path.join(__dirname, '../app/assets/images'), cacheOpts)
    )
);
app.use(
    mount(
        '/javascripts',
        staticCache(
            path.join(__dirname, '../app/assets/javascripts'),
            cacheOpts
        )
    )
);
// Proxy asset folder to webpack development server in development mode
if (env === 'development') {
    const webpack_dev_port = process.env.PORT
        ? parseInt(process.env.PORT) + 1
        : 8081;
    const proxyhost = 'http://0.0.0.0:' + webpack_dev_port;
    console.log('proxying to webpack dev server at ' + proxyhost);
    const proxy = require('koa-proxy')({
        host: proxyhost,
        map: filePath => 'assets/' + filePath,
    });
    app.use(mount('/assets', proxy));
} else {
    app.use(
        mount(
            '/assets',
            staticCache(path.join(__dirname, '../../dist'), cacheOpts)
        )
    );
}

let resolvedAssets = false;
let supportedLocales = false;

if (process.env.NODE_ENV === 'production') {
    resolvedAssets = require(path.join(
        __dirname,
        '../..',
        '/tmp/webpack-stats-prod.json'
    ));
    supportedLocales = getSupportedLocales();
}

app.use(isBot());

// set number of processes equal to number of cores
// (unless passed in as an env var)
const numProcesses = process.env.NUM_PROCESSES || os.cpus().length;

const statsLoggerClient = new StatsLoggerClient(process.env.STATSD_IP);

app.use(requestTime(statsLoggerClient));

app.keys = [config.get('session_key')];

const crypto_key = config.get('server_session_secret');
session(app, {
    maxAge: 1000 * 3600 * 24 * 60,
    crypto_key,
    key: config.get('session_cookie_key'),
});
csrf(app);

koaLocale(app);

function convertEntriesToArrays(obj) {
    const conf = Object.keys(obj).reduce((result, key) => {
        result[key] = obj[key].split(/\s+/);
        return result;
    }, {});
    console.log('convertEntriesToArrays:', JSON.stringify(conf));
    // remove connect-src and plugin-types
    delete conf.pluginTypes;
    // add nonce support
    const nonceCb = (req, res) => {
        return `'nonce-${req.cspNonce}'`;
    };
    if (!conf.scriptSrc) {
        conf.scriptSrc = [];
    }
    conf.scriptSrc.push(nonceCb);
    if (!conf.defaultSrc) {
        conf.defaultSrc = [];
    }
    conf.defaultSrc.push(nonceCb);
    return conf;
}

const steemMarket = new SteemMarket();
app.use(function*(next) {
    this.steemMarketData = yield steemMarket.get();
    yield next;
});

// some redirects and health status
app.use(function*(next) {
    if (this.method === 'GET' && this.url === '/.well-known/healthcheck.json') {
        this.status = 200;
        this.body = {
            status: 'ok',
            docker_tag: process.env.DOCKER_TAG ? process.env.DOCKER_TAG : false,
            source_commit: process.env.SOURCE_COMMIT
                ? process.env.SOURCE_COMMIT
                : false,
        };
        return;
    }

    // redirect to home page if known account
    if (this.method === 'GET' && this.url === '/' && this.session.a) {
        this.status = 302;
        this.redirect(`/@${this.session.a}/transfers`);
        return;
    }
    // normalize user name url from cased params
    if (this.method === 'GET' && routeRegex.UserProfile1.test(this.url)) {
        const p = this.originalUrl.toLowerCase();
        let userCheck = '';
        userCheck = p.split('/')[1].slice(1);
        if (userIllegalContent.includes(userCheck)) {
            console.log('Illegal content user found blocked', userCheck);
            this.status = 451;
            return;
        }
        if (p !== this.originalUrl) {
            this.status = 301;
            this.redirect(p);
            return;
        }
    }
    // remember ch, cn, r url params in the session and remove them from url
    if (this.method === 'GET' && /\?[^\w]*(ch=|cn=|r=)/.test(this.url)) {
        let redir = this.url.replace(/((ch|cn|r)=[^&]+)/gi, r => {
            const p = r.split('=');
            if (p.length === 2) this.session[p[0]] = p[1];
            return '';
        });
        redir = redir.replace(/&&&?/, '');
        redir = redir.replace(/\?&?$/, '');
        console.log(`server redirect ${this.url} -> ${redir}`);
        this.status = 302;
        this.redirect(redir);
    } else {
        yield next;
    }
});

// load production middleware
if (env === 'production') {
    app.use(require('koa-conditional-get')());
    app.use(require('koa-etag')());
    app.use(require('koa-compressor')());
}

// Logging
if (env === 'production') {
    app.use(prod_logger());
} else {
    app.use(koa_logger());
}

// Sets the `script-src` directive to
// "'self' 'nonce-e33ccde670f149c1789b1e1e113b0916'"
// (or similar)
app.use(function*(next) {
    this.session.cspNonce = secureRandom.randomBuffer(16).toString('hex');
    this.req.cspNonce = this.session.cspNonce;
    yield next;
});

app.use(
    helmet({
        hsts: false,
    })
);

app.use(
    mount(
        '/static',
        staticCache(path.join(__dirname, '../app/assets/static'), cacheOpts)
    )
);

app.use(
    mount(
        '/.well-known',
        staticCache(path.join(__dirname, '../../.well-known'), cacheOpts)
    )
);

app.use(
    mount('/robots.txt', function*() {
        this.set('Cache-Control', 'public, max-age=86400000');
        this.type = 'text/plain';
        this.body = 'User-agent: *\nAllow: /';
    })
);

// set user's uid - used to identify users in logs and some other places
// FIXME SECURITY PRIVACY cycle this uid after a period of time
app.use(function*(next) {
    const last_visit = this.session.last_visit;
    this.session.last_visit = (new Date().getTime() / 1000) | 0;
    const from_link = this.request.headers.referer;
    if (!this.session.uid) {
        this.session.uid = secureRandom.randomBuffer(13).toString('hex');
        this.session.new_visit = true;
        if (from_link) this.session.r = from_link;
    } else {
        this.session.new_visit = this.session.last_visit - last_visit > 1800;
        if (!this.session.r && from_link) {
            this.session.r = from_link;
        }
    }
    yield next;
});

useRedirects(app);
useEnterAndConfirmEmailPages(app);
useEnterAndConfirmMobilePages(app);

useAccountRecoveryApi(app);

useGeneralApi(app);

// helmet wants some things as bools and some as lists, makes config difficult.
// our config uses strings, this splits them to lists on whitespace.
console.log('SDC_HELMET_CONNECTSRC:', process.env.SDC_HELMET_CONNECTSRC);
console.log('SDC_HELMET_SCRIPTSRC:', process.env.SDC_HELMET_SCRIPTSRC);
if (env === 'production') {
    const helmetConfig = {
        directives: convertEntriesToArrays(config.get('helmet.directives')),
        reportOnly: config.get('helmet.reportOnly'),
        setAllHeaders: config.get('helmet.setAllHeaders'),
    };
    helmetConfig.directives.reportUri = helmetConfig.directives.reportUri[0];
    if (helmetConfig.directives.reportUri === '-') {
        delete helmetConfig.directives.reportUri;
    }
    app.use(helmet.contentSecurityPolicy(helmetConfig));
}

if (env !== 'test') {
    const appRender = require('./app_render');

    app.use(function*() {
        yield appRender(this, supportedLocales, resolvedAssets);
        // if (app_router.dbStatus.ok) recordWebEvent(this, 'page_load');
        const bot = this.state.isBot;
        if (bot) {
            console.log(
                `  --> ${this.method} ${this.originalUrl} ${
                    this.status
                } (BOT '${bot}')`
            );
        }
    });

    const argv = minimist(process.argv.slice(2));

    const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;

    if (env === 'production') {
        if (cluster.isMaster) {
            for (let i = 0; i < numProcesses; i++) {
                cluster.fork();
            }
            // if a worker dies replace it so application keeps running
            cluster.on('exit', function(worker) {
                console.log(
                    'error: worker %d died, starting a new one',
                    worker.id
                );
                cluster.fork();
            });
        } else {
            app.listen(port);
            if (process.send) process.send('online');
            console.log(`Worker process started for port ${port}`);
        }
    } else {
        // spawn a single thread if not running in production mode
        app.listen(port);
        if (process.send) process.send('online');
        console.log(`Application started on port ${port}`);
    }
}

// set PERFORMANCE_TRACING to the number of seconds desired for
// logging hardware stats to the console
if (process.env.PERFORMANCE_TRACING)
    setInterval(hardwareStats, 1000 * process.env.PERFORMANCE_TRACING);

module.exports = app;
