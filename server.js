'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { initDatabase } = require('./src/db/database');
const { seedDatabase } = require('./src/db/seed');
const { handleApiRequest } = require('./src/api/router');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function createSafeRulesServer(customDbPath) {
  const db = initDatabase(customDbPath);
  seedDatabase(db, false);

  const publicDir = path.join(__dirname, 'public');

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsed.pathname || '/';

    if (pathname.startsWith('/api/')) {
      return handleApiRequest(req, res, db);
    }

    // Serve static files from /public
    let safePath = pathname === '/' ? '/index.html' : pathname;
    safePath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(publicDir, safePath);

    if (!fullPath.startsWith(publicDir)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
      });
      return fs.createReadStream(fullPath).pipe(res);
    }

    // Fallback to index.html for SPA navigation
    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(indexPath).pipe(res);
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return { server, db };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3080);
  const { server } = createSafeRulesServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`====================================================================`);
    console.log(`  SAFE RULES v1.2 - Rule-Based Data Validation & Enrichment Platform`);
    console.log(`  URL: http://127.0.0.1:${PORT}`);
    console.log(`====================================================================`);
  });
}

module.exports = { createSafeRulesServer };
