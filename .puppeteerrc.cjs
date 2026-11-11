const { join } = require('node:path');

/**
 * Keep the downloaded Chrome INSIDE the project folder. By default Puppeteer stores it in the home directory
 * (~/.cache/puppeteer), which hosts like Render do not carry from the build step to the running service, so the
 * browser is "missing" at runtime and every PDF fails. The project folder is carried over.
 */
module.exports = { cacheDirectory: join(__dirname, '.cache', 'puppeteer') };
