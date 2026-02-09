#!/usr/bin/env node
/**
 * Simple Kanban Server with API
 * Serves static files + provides API for heartbeat access
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const DATA_FILE = '/home/moltbot/kanban/kanban_data.json';
const BOARD_DIR = '/home/moltbot/kanban';

// MIME types
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

// Read board data
function getBoardData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
        // Default board
        return {
            columns: [
                { id: 1, title: 'Nexus Tasks', tasks: [] },
                { id: 2, title: 'In Progress', tasks: [] },
                { id: 3, title: 'Done', tasks: [] }
            ],
            initiatives: []
        };
    } catch (e) {
        return {
            columns: [
                { id: 1, title: 'Nexus Tasks', tasks: [] },
                { id: 2, title: 'In Progress', tasks: [] },
                { id: 3, title: 'Done', tasks: [] }
            ],
            initiatives: []
        };
    }
}

// Save board data
function saveBoardData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// HTTP Handler
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;
    
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    // API Endpoints
    if (pathname === '/api/board' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getBoardData()));
        return;
    }
    
    if (pathname === '/api/board' && (req.method === 'POST' || req.method === 'PUT')) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                saveBoardData(data);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // Serve static files
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(BOARD_DIR, filePath);
    
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain';
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Kanban Server running on port ${PORT}`);
    console.log(`📁 Data file: ${DATA_FILE}`);
});
