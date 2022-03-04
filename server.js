const path = require("path");
const fs = require("fs");
const finalhandler = require("finalhandler");
const { createServer } = require("http");
const { WebSocketServer } = require("ws");
const mime = require("mime");
const ssri = require("ssri");
const devip = require("dev-ip");
const debug = require("debug")("EleventyServeAdapter");

const wrapResponse = require("./server/wrapResponse.js");

const serverCache = {};
const DEFAULT_OPTIONS = {
  port: 8080,
  enabled: true,        // Enable live reload at all
  showAllHosts: false,  // IP address based hosts (other than localhost)
  folder: ".11ty",      // Change the name of the special folder used for injected scripts
  portReassignmentRetryCount: 10, // number of times to increment the port if in use
}

class EleventyServeAdapter {
  static getServer(...args) {
    let [name] = args;

    if (!serverCache[name]) {
      serverCache[name] = new EleventyServeAdapter(...args);
    }

    return serverCache[name];
  }

  constructor(name, deps = {}, options = {}) {
    this.name = name;
    this.options = Object.assign({}, DEFAULT_OPTIONS, options);
    this.fileCache = {};
    
    let requiredDependencyKeys = ["logger", "outputDir", "templatePath", "transformUrl", "pathPrefix"];
    for(let key of requiredDependencyKeys) {
      if(!deps[key]) {
        throw new Error(`Missing injected upstream dependency: ${key}`);
      }
    }

    let { logger, templatePath, transformUrl, pathPrefix, outputDir } = deps;
    this.logger = logger;
    this.outputDir = outputDir;
    this.templatePath = templatePath;
    this.transformUrl = transformUrl; // add pathPrefix to template urls for client comparison
    this.pathPrefix = pathPrefix;
  }

  getOutputDirFilePath(filepath, filename = "") {
    let computedPath;
    if(filename === ".html") {
      // avoid trailing slash for filepath/.html requests
      computedPath = path.join(this.outputDir, filepath) + filename;
    } else {
      computedPath = path.join(this.outputDir, filepath, filename);
    }

    // Check that the file is in the output path (error if folks try use `..` in the filepath)
    let absComputedPath = this.templatePath.absolutePath(computedPath);
    let absOutputDir = this.templatePath.absolutePath(computedPath);
    if (!absComputedPath.startsWith(absOutputDir)) {
      throw new Error("Invalid path");
    }

    return computedPath;
  }

  isOutputFilePathExists(rawPath) {
    return fs.existsSync(rawPath) && !this.templatePath.isDirectorySync(rawPath);
  }

  /* Use conventions documented here https://www.zachleat.com/web/trailing-slash/
   * resource.html exists:
   *    /resource matches
   *    /resource/ redirects to /resource
   * resource/index.html exists:
   *    /resource redirects to /resource/
   *    /resource/ matches
   * both resource.html and resource/index.html exists:
   *    /resource matches /resource.html
   *    /resource/ matches /resource/index.html
   */
  mapUrlToFilePath(url) {
    // Note: `localhost` is not important here, any host would work
    let u = new URL(url, "http://localhost/");
    url = u.pathname;

    if (this.pathPrefix !== "/") {
      if (!url.startsWith(this.pathPrefix)) {
        return {
          statusCode: 404,
        };
      }

      url = url.substr(this.pathPrefix.length);
    }

    let rawPath = this.getOutputDirFilePath(url);
    if (this.isOutputFilePathExists(rawPath)) {
      return {
        statusCode: 200,
        filepath: rawPath,
      };
    }

    let indexHtmlPath = this.getOutputDirFilePath(url, "index.html");
    let indexHtmlExists = fs.existsSync(indexHtmlPath);

    let htmlPath = this.getOutputDirFilePath(url, ".html");
    let htmlExists = fs.existsSync(htmlPath);

    // /resource/ => /resource/index.html
    if (indexHtmlExists) {
      if (url.endsWith("/")) {
        return {
          statusCode: 200,
          filepath: indexHtmlPath,
        };
      }

      return {
        statusCode: 301,
        url: url + "/",
      };
    }

    // /resource => resource.html
    if (htmlExists) {
      if (!url.endsWith("/")) {
        return {
          statusCode: 200,
          filepath: htmlPath,
        };
      }

      return {
        statusCode: 301,
        url: url + "/",
      };
    }

    return {
      statusCode: 404,
    };
  }

  _getFileContents(localpath) {
    if(this.fileCache[localpath]) {
      return this.fileCache[localpath];
    }

    let filepath = this.templatePath.absolutePath(
      __dirname,
      localpath
    );
    return fs.readFileSync(filepath, {
      encoding: "utf8",
    });
  }

  augmentContentWithNotifier(content) {
    // This isn’t super necessary because it’s a local file, but it’s included anyway
    let integrity = ssri.fromData(this._getFileContents("./client/reload-client.js"));
    let script = `<script type="module" integrity="${integrity}" src="/${this.options.folder}/reload-client.js"></script>`;

    // <title> is the only *required* element in an HTML document
    if (content.includes("</title>")) {
      return content.replace("</title>", `</title>${script}`);
    }

    // If you’ve reached this section, your HTML is invalid!
    // We want to be super forgiving here, because folks might be in-progress editing the document!
    if (content.includes("</head>")) {
      return content.replace("</head>", `${script}</head>`);
    }
    if (content.includes("</body>")) {
      return content.replace("</body>", `${script}</body>`);
    }
    if (content.includes("</html>")) {
      return content.replace("</html>", `${script}</html>`);
    }
    if (content.includes("<!doctype html>")) {
      return content.replace("<!doctype html>", `<!doctype html>${script}`);
    }

    // Notably, works without content at all!!
    return (content || "") + script;
  }

  requestMiddleware(req, res) {
    let next = finalhandler(req, res, {
      onerror: (e) => {
        if (e.statusCode === 404) {
          let localPath = this.templatePath.stripLeadingSubPath(
            e.path,
            this.templatePath.absolutePath(this.outputDir)
          );
          this.logger.error(
            `HTTP ${e.statusCode}: Template not found in output directory (${this.outputDir}): ${localPath}`
          );
        } else {
          this.logger.error(`HTTP ${e.statusCode}: ${e.message}`);
        }
      },
    });

    if(req.url === `/${this.options.folder}/reload-client.js`) {
      res.setHeader("Content-Type", mime.getType("js"));
      return res.end(this._getFileContents("./client/reload-client.js"));
    } else if(req.url === `/${this.options.folder}/morphdom.js`) {
      res.setHeader("Content-Type", mime.getType("js"));
      return res.end(this._getFileContents("./node_modules/morphdom/dist/morphdom-esm.js"));
    }

    let match = this.mapUrlToFilePath(req.url);
    if (match) {
      if (match.statusCode === 200 && match.filepath) {
        let contents = fs.readFileSync(match.filepath);
        let mimeType = mime.getType(match.filepath);
        if (mimeType === "text/html") {
          res.setHeader("Content-Type", mimeType);
          // the string is important here, wrapResponse expects strings internally for HTML content (for now)
          return res.end(contents.toString());
        }

        if (mimeType) {
          res.setHeader("Content-Type", mimeType);
        }
        return res.end(contents);
      }

      // TODO add support for 404 pages (in different Jamstack server configurations)
      if (match.url) {
        res.writeHead(match.statusCode, {
          Location: match.url,
        });
        return res.end();
      }
    }

    next();
  }

  get server() {
    if (this._server) {
      return this._server;
    }

    this._server = createServer(async (req, res) => {
      res = wrapResponse(res, content => {
        if(this.options.enabled !== false) {
          return this.augmentContentWithNotifier(content);
        }
        return content;
      });

      let middlewares = this.options.middleware || [];
      if(middlewares.length) {
        let nexts = [];
        // Iterate over those middlewares
        middlewares.forEach((ware, index) => {
          let nextWare = middlewares[index + 1] || this.requestMiddleware.bind(this, req, res);
          nexts.push(ware.bind(null, req, res, nextWare));
        });
        for(let ware of nexts) {
          await ware();
        }
      } else {
        this.requestMiddleware(req, res)
      }
    });

    this.portRetryCount = 0;
    this._server.on("error", (err) => {
      if (err.code == "EADDRINUSE") {
        if (this.portRetryCount < this.options.portReassignmentRetryCount) {
          this.portRetryCount++;
          debug(
            "Server already using port %o, trying the next port %o. Retry number %o of %o",
            err.port,
            err.port + 1,
            this.portRetryCount,
            this.options.portReassignmentRetryCount
          );
          this._serverListen(err.port + 1);
        } else {
          throw new Error(
            `Tried ${this.options.portReassignmentRetryCount} different ports but they were all in use. You can a different starter port using --port on the command line.`
          );
        }
      } else {
        this._serverErrorHandler(err);
      }
    });

    this._server.on("listening", (e) => {
      this.setupReloadNotifier();
      let { port } = this._server.address();

      let hostsStr = "";
      if(this.options.showAllHosts) {
        let hosts = devip().map(host => `http://${host}:${port}${this.pathPrefix} or`);
        hostsStr = hosts.join(" ") + " ";
      }

      this.logger.message(
        `Server at ${hostsStr}http://localhost:${port}${this.pathPrefix} `,
        "log",
        "blue",
        true
      );
    });

    return this._server;
  }

  _serverListen(port) {
    this.server.listen({
      port,
    });
  }

  init(options) {
    this._serverListen(options.port);
  }

  _serverErrorHandler(err) {
    if (err.code == "EADDRINUSE") {
      this.logger.error(`Server error: Port in use ${err.port}`);
    } else {
      this.logger.error(`Server error: ${err.message}`);
    }
  }

  // Websocket Notifications
  setupReloadNotifier() {
    let updateServer = new WebSocketServer({
      server: this.server,
    });

    updateServer.on("connection", (ws) => {
      this.updateNotifier = ws;

      this.sendUpdateNotification({
        type: "eleventy.status",
        status: "connected",
      });
    });

    updateServer.on("error", (err) => {
      this._serverErrorHandler(err);
    });
  }

  sendUpdateNotification(obj) {
    if (this.updateNotifier) {
      this.updateNotifier.send(JSON.stringify(obj));
    }
  }

  exit() {
    this.sendUpdateNotification({
      type: "eleventy.status",
      status: "disconnected",
    });
  }

  sendError({ error }) {
    this.sendUpdateNotification({
      type: "eleventy.error",
      // Thanks https://stackoverflow.com/questions/18391212/is-it-not-possible-to-stringify-an-error-using-json-stringify
      error: JSON.stringify(error, Object.getOwnPropertyNames(error)),
    });
  }

  async reload({ subtype, files, build }) {
    if (build.templates) {
      build.templates = build.templates
        .filter(entry => !!entry)
        .filter(entry => {
          // Filter to only include watched templates that were updated
          return (files || []).includes(entry.inputPath);
        })
        .map(entry => {
          // Add pathPrefix to all template urls
          entry.url = this.transformUrl(this.pathPrefix, entry.url);
          return entry;
        });
    }

    this.sendUpdateNotification({
      type: "eleventy.reload",
      subtype,
      files,
      build,
    });
  }
}
module.exports = EleventyServeAdapter;