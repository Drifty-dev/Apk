import express from 'express';
import cors from 'cors';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';
import simpleGit from 'simple-git';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

wss.on('connection', (ws) => {
  let proc = null;
  ws.on('message', (raw) => {
    try {
      const { type, code, lang, command, cwd } = JSON.parse(raw.toString());
      if (type === 'run_code') {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-'));
        let filename, runCmd;
        if (lang === 'python' || lang === 'py') { filename = path.join(tmpDir, 'main.py'); fs.writeFileSync(filename, code); runCmd = `python3 "${filename}"`; }
        else if (lang === 'javascript' || lang === 'js') { filename = path.join(tmpDir, 'main.js'); fs.writeFileSync(filename, code); runCmd = `node "${filename}"`; }
        else if (lang === 'bash' || lang === 'sh') { filename = path.join(tmpDir, 'main.sh'); fs.writeFileSync(filename, code); runCmd = `bash "${filename}"`; }
        else { ws.send(JSON.stringify({ type: 'stderr', data: 'Unsupported language: ' + lang })); ws.send(JSON.stringify({ type: 'exit', code: 1 })); return; }
        ws.send(JSON.stringify({ type: 'start' }));
        proc = spawn('sh', ['-c', runCmd], { cwd: tmpDir });
        proc.stdout.on('data', d => ws.send(JSON.stringify({ type: 'stdout', data: d.toString() })));
        proc.stderr.on('data', d => ws.send(JSON.stringify({ type: 'stderr', data: d.toString() })));
        proc.on('close', code => { ws.send(JSON.stringify({ type: 'exit', code })); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
      } else if (type === 'kill') {
        if (proc) { proc.kill('SIGTERM'); proc = null; }
      } else if (type === 'shell') {
        proc = spawn('sh', ['-c', command], { cwd: cwd || os.homedir(), env: process.env });
        proc.stdout.on('data', d => ws.send(JSON.stringify({ type: 'stdout', data: d.toString() })));
        proc.stderr.on('data', d => ws.send(JSON.stringify({ type: 'stderr', data: d.toString() })));
        proc.on('close', code => ws.send(JSON.stringify({ type: 'exit', code })));
      }
    } catch (e) { ws.send(JSON.stringify({ type: 'stderr', data: e.message })); }
  });
  ws.on('close', () => { if (proc) proc.kill(); });
});

app.post('/api/chat', async (req, res) => {
  const { messages, model, temperature, stream, ollamaUrl } = req.body;
  const base = ollamaUrl || 'http://localhost:11434';
  try {
    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || 'godmoded/llama3-lexi-uncensored', messages, temperature: temperature ?? 0.7, stream: stream !== false }),
    });
    if (!resp.ok) { res.status(resp.status).json({ error: await resp.text() }); return; }
    if (stream !== false) {
      res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
      const reader = resp.body.getReader(); const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.write('data: [DONE]\n\n'); res.end(); break; }
        const text = decoder.decode(value);
        for (const line of text.split('\n').filter(l => l.trim())) {
          try { const json = JSON.parse(line); res.write(`data: ${JSON.stringify(json)}\n\n`); if (json.done) { res.end(); return; } } catch {}
        }
      }
    } else { res.json(await resp.json()); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ollama/status', async (req, res) => {
  const base = req.query.url || 'http://localhost:11434';
  try { const r = await fetch(`${base}/api/tags`); res.json({ connected: r.ok }); } catch { res.json({ connected: false }); }
});

app.get('/api/ollama/models', async (req, res) => {
  const base = req.query.url || 'http://localhost:11434';
  try { const r = await fetch(`${base}/api/tags`); if (!r.ok) throw new Error('Not reachable'); res.json(await r.json()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/project/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file' }); return; }
    const TEXT_EXTS = ['.js','.ts','.tsx','.jsx','.py','.html','.css','.json','.md','.txt','.sh','.yaml','.yml','.toml','.rs','.go','.java','.cpp','.c','.h','.sql'];
    let files = [];
    if (req.file.originalname.endsWith('.zip')) {
      const zip = new AdmZip(req.file.buffer);
      for (const e of zip.getEntries()) {
        if (!e.isDirectory) {
          const ext = path.extname(e.entryName).toLowerCase();
          const isText = TEXT_EXTS.includes(ext) || !ext;
          files.push({ name: e.entryName, content: isText ? e.getData().toString('utf8') : `[binary: ${ext}]`, type: isText ? 'text' : 'binary' });
        }
      }
    } else {
      files = [{ name: req.file.originalname, content: req.file.buffer.toString('utf8'), type: 'text' }];
    }
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-file', async (req, res) => {
  try { await fsp.writeFile(req.body.path, req.body.content, 'utf8'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const gitR = (p) => simpleGit(p || process.cwd());
app.post('/api/git/status', async (req, res) => { try { res.json({ status: await gitR(req.body.repoPath).status() }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/git/diff', async (req, res) => { try { res.json({ diff: req.body.file ? await gitR(req.body.repoPath).diff([req.body.file]) : await gitR(req.body.repoPath).diff() }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/git/commit', async (req, res) => {
  try {
    const git = gitR(req.body.repoPath);
    if (req.body.files?.length) await git.add(req.body.files); else await git.add('.');
    res.json({ result: await git.commit(req.body.message || 'WormGPT commit') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/git/branch', async (req, res) => { try { await gitR(req.body.repoPath).checkoutLocalBranch(req.body.name); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });

const distPath = path.join(__dirname, '..', 'app', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (_, res) => res.sendFile(path.join(distPath, 'index.html')));
}

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n🐛 WormGPT Server → http://localhost:${PORT}`);
  console.log(`📡 WebSocket → ws://localhost:${PORT}\n`);
});
