/**
 * Simple Local Server for MessyTax Frontend
 * 
 * Usage: node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5500;

http.createServer((req, res) => {
    console.log(`request ${req.method} ${req.url}`);

    let filePath = '.' + req.url;
    if (filePath === './' || filePath.indexOf('?') !== -1) {
        // Handle basic routing and query params
        if (filePath === './' || filePath.startsWith('./?')) {
            filePath = './index.html';
        } else if (filePath.includes('?')) {
            filePath = filePath.split('?')[0];
        }
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.wav': 'audio/wav',
        '.mp4': 'video/mp4',
        '.woff': 'application/font-woff',
        '.ttf': 'application/font-ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.otf': 'application/font-otf',
        '.wasm': 'application/wasm'
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, function(error, content) {
        if (error) {
            if (error.code == 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('404 Not Found', 'utf-8');
            } else {
                res.writeHead(500);
                res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });

}).listen(PORT);

console.log(`🚀 MessyTax Frontend running at http://127.0.0.1:${PORT}/`);
console.log('Press Ctrl+C to stop.');
