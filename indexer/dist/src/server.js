import * as http from 'node:http';
import { URL } from 'node:url';
export function createServer(db) {
    return http.createServer((req, res) => {
        const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const { pathname, searchParams } = parsedUrl;
        // Helper to send json
        const sendJson = (statusCode, data) => {
            res.writeHead(statusCode, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            });
            res.end(JSON.stringify(data));
        };
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            });
            res.end();
            return;
        }
        if (req.method !== 'GET') {
            sendJson(405, { error: 'Method not allowed' });
            return;
        }
        // Health check endpoint
        if (pathname === '/health') {
            sendJson(200, { status: 'ok', cursor: db.getCursor() });
            return;
        }
        // GET /streams?recipient=<address>
        if (pathname === '/streams') {
            const recipient = searchParams.get('recipient');
            if (!recipient) {
                sendJson(200, []);
                return;
            }
            const streams = db.getStreamsByRecipient(recipient);
            sendJson(200, streams);
            return;
        }
        // GET /streams/:id/history
        const historyMatch = pathname.match(/^\/streams\/([^/]+)\/history$/);
        if (historyMatch) {
            const streamId = historyMatch[1];
            if (!streamId) {
                sendJson(200, []);
                return;
            }
            const events = db.getStreamHistory(streamId).map((row) => {
                let parsedPayload = row.payload;
                try {
                    parsedPayload = JSON.parse(row.payload);
                }
                catch {
                    // Keep as string if parsing fails
                }
                return {
                    ...row,
                    payload: parsedPayload,
                };
            });
            sendJson(200, events);
            return;
        }
        sendJson(404, { error: 'Not found' });
    });
}
