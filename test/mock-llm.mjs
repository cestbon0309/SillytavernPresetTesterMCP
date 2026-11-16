// Minimal OpenAI-compatible mock for testing stpd without a real API key.
//   node test/mock-llm.mjs [port=8199] [delayMs=1500]
// Every request is logged to test/.mock-requests.jsonl (body hash + arrival time) so tests can check
// that batch requests were identical and concurrent.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 8199);
const delay = Number(process.argv[3] || 1500);
const logFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.mock-requests.jsonl');
let counter = 0;

http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && req.url.endsWith('/models')) {
        return send(200, { object: 'list', data: ['mock-a', 'mock-b', 'mock-fail', 'mock-flaky'].map(id => ({ id, object: 'model' })) });
    }
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        const n = ++counter;
        const arrived = Date.now();
        const json = JSON.parse(body || '{}');
        const hash = crypto.createHash('sha256').update(JSON.stringify(json.messages)).digest('hex').slice(0, 12);
        fs.appendFileSync(logFile, JSON.stringify({ n, arrived, hash, model: json.model, temperature: json.temperature, messages: json.messages.length }) + '\n');
        await new Promise(r => setTimeout(r, delay));
        if (json.model === 'mock-fail' || (json.model === 'mock-flaky' && n % 2 === 0)) {
            return send(500, { error: { message: `mock failure on request ${n}` } });
        }
        const lastUser = [...json.messages].reverse().find(m => m.role === 'user');
        const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
        const content = `<think>mock reasoning ${n}</think>Reply #${n} (prompt ${hash}, ${json.messages.length} msgs). You said: "${(userText || '').slice(0, 60)}". Lucky number ${Math.floor(Math.random() * 1000)}.`;
        return send(200, {
            id: `mock-${n}`, object: 'chat.completion', created: Math.floor(arrived / 1000), model: json.model,
            choices: [{
                index: 0,
                message: json.model === 'mock-reasoner'
                    ? { role: 'assistant', content: content.replace(/<think>.*?<\/think>/, ''), reasoning_content: `separate reasoning ${n}` }
                    : { role: 'assistant', content },
                finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100 + json.messages.length, completion_tokens: 30, total_tokens: 130 + json.messages.length },
        });
    }
    send(404, { error: { message: `mock: no route ${req.method} ${req.url}` } });
}).listen(port, '127.0.0.1', () => console.log(`mock LLM on http://127.0.0.1:${port}/v1 (delay ${delay}ms)`));
