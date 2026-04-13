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
  const resolvedModel = (model && model !== 'godmoded/llama3-lexi-uncensored') ? model : 'tinyllama';
  try {
    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: resolvedModel, messages, temperature: temperature ?? 0.7, stream: stream !== false }),
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

// ─── Download Page ────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');

function addDirToZip(zip, dirPath, zipBasePath) {
  if (!fs.existsSync(dirPath)) return;
  const SKIP = ['node_modules', '.gradle', 'build', '.git', 'dist', '.DS_Store'];
  const entries = fs.readdirSync(dirPath);
  for (const entry of entries) {
    if (SKIP.includes(entry)) continue;
    const fullPath = path.join(dirPath, entry);
    const zipPath = path.join(zipBasePath, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      addDirToZip(zip, fullPath, zipPath);
    } else {
      try { zip.addLocalFile(fullPath, path.dirname(zipPath), path.basename(zipPath)); } catch {}
    }
  }
}

app.get('/download', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WormGPT — Descargar proyecto Android</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --red: #e94560; --dark: #0a0a0a; --card: #111; --border: rgba(233,69,96,0.25); }
    html { background: var(--dark); }
    body { background: var(--dark); color: #fff; font-family: 'Segoe UI', system-ui, sans-serif; padding: 32px 16px 48px; min-height: 100%; }
    .wrap { max-width: 560px; margin: 0 auto; position: relative; z-index: 1; }
    .particles { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
    .particle { position: absolute; width: 2px; height: 2px; background: var(--red); border-radius: 50%; opacity: 0.3; animation: float linear infinite; }
    @keyframes float { 0% { transform: translateY(100vh) rotate(0deg); opacity: 0; } 10% { opacity: 0.3; } 90% { opacity: 0.3; } 100% { transform: translateY(-100px) rotate(720deg); opacity: 0; } }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 24px; padding: 40px 32px; width: 100%; text-align: center; box-shadow: 0 0 80px rgba(233,69,96,0.08); }
    .logo { width: 80px; height: 80px; border-radius: 20px; background: linear-gradient(135deg, #e94560, #9b1c3c); display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 36px; box-shadow: 0 8px 32px rgba(233,69,96,0.35); }
    h1 { font-size: 1.7rem; font-weight: 700; margin-bottom: 8px; }
    .sub { color: rgba(255,255,255,0.5); font-size: 0.92rem; margin-bottom: 28px; line-height: 1.6; }
    .steps { text-align: left; background: rgba(233,69,96,0.06); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; margin-bottom: 28px; }
    .steps h3 { color: var(--red); font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 14px; }
    .step { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; font-size: 0.86rem; color: rgba(255,255,255,0.75); line-height: 1.5; }
    .step:last-child { margin-bottom: 0; }
    .num { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: var(--red); color: #fff; font-size: 0.7rem; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: 1px; }
    .code { background: rgba(0,0,0,0.4); border: 1px solid rgba(233,69,96,0.2); border-radius: 6px; padding: 2px 8px; font-family: monospace; font-size: 0.8rem; color: #f87171; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; padding: 18px 24px; background: linear-gradient(135deg, #e94560, #c0264a); color: #fff; font-size: 1rem; font-weight: 700; text-decoration: none; border: none; border-radius: 14px; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 24px rgba(233,69,96,0.35); letter-spacing: 0.02em; -webkit-tap-highlight-color: transparent; }
    .btn:active { opacity: 0.85; transform: scale(0.98); }
    .btn svg { flex-shrink: 0; }
    .note { margin-top: 18px; font-size: 0.76rem; color: rgba(255,255,255,0.3); line-height: 1.6; }
    .badge { display: inline-flex; align-items: center; gap: 5px; background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.3); color: #4ade80; font-size: 0.72rem; font-weight: 600; padding: 3px 10px; border-radius: 20px; margin-bottom: 16px; }
    @media (max-width: 400px) { .card { padding: 28px 16px; } h1 { font-size: 1.4rem; } body { padding: 20px 12px 40px; } }
  </style>
</head>
<body>
  <div class="particles" id="particles"></div>
  <div class="wrap"><div class="card">
    <div class="badge">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><circle cx="5" cy="5" r="5"/></svg>
      Listo para compilar
    </div>
    <div class="logo">🐛</div>
    <h1>WormGPT Android</h1>
    <p class="sub">Descarga el proyecto Android preconfigurado con GitHub Actions. Solo súbelo a GitHub y el APK se compilará automáticamente.</p>

    <div class="steps">
      <h3>Pasos para obtener el APK</h3>
      <div class="step"><div class="num">1</div><div>Descarga el ZIP y extráelo en tu computadora</div></div>
      <div class="step"><div class="num">2</div><div>Crea un repositorio en <strong>github.com</strong> y sube todos los archivos</div></div>
      <div class="step"><div class="num">3</div><div>Ve a la pestaña <span class="code">Actions</span> → el workflow <span class="code">Build Android APK</span> se ejecutará solo</div></div>
      <div class="step"><div class="num">4</div><div>Cuando termine (~5 min), descarga el APK desde <span class="code">Artifacts</span></div></div>
      <div class="step"><div class="num">5</div><div>Instala el APK en tu Android activando "fuentes desconocidas"</div></div>
    </div>

    <a class="btn" href="/api/download/android-project.zip" id="dlBtn">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Descargar proyecto Android (.zip)
    </a>
    <p class="note">El ZIP incluye el proyecto Capacitor/Android + el workflow de GitHub Actions ya configurado.<br>No se necesita instalar nada extra en tu PC.</p>
  </div></div>

  <script>
    const p = document.getElementById('particles');
    for (let i = 0; i < 18; i++) {
      const el = document.createElement('div');
      el.className = 'particle';
      el.style.left = Math.random() * 100 + '%';
      el.style.animationDuration = (8 + Math.random() * 12) + 's';
      el.style.animationDelay = (Math.random() * 8) + 's';
      p.appendChild(el);
    }
    document.getElementById('dlBtn').addEventListener('click', function() {
      this.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Preparando ZIP...';
      setTimeout(() => {
        this.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Descargar proyecto Android (.zip)';
      }, 3000);
    });
  </script>
</body>
</html>`);
});

app.get('/api/download/android-project.zip', (req, res) => {
  try {
    const zip = new AdmZip();
    const androidDir = path.join(ROOT, 'app', 'android');
    const workflowFile = path.join(ROOT, '.github', 'workflows', 'build-android.yml');
    addDirToZip(zip, androidDir, 'android');
    if (fs.existsSync(workflowFile)) {
      zip.addLocalFile(workflowFile, '.github/workflows', 'build-android.yml');
    }
    const readme = `# WormGPT Android — Instrucciones para compilar el APK

## Requisitos
Solo necesitas una cuenta gratuita en GitHub.

## Pasos

### 1. Crear repositorio en GitHub
1. Ve a https://github.com/new
2. Nombre: \`wormgpt-android\` (o el que quieras)
3. Visibilidad: **Privado** (recomendado)
4. Haz clic en "Create repository"

### 2. Subir los archivos
Sube todos los archivos de este ZIP al repositorio:
- La carpeta \`android/\` completa
- La carpeta \`.github/\` con el workflow

### 3. Esperar el build automático
GitHub Actions compilará el APK automáticamente.
Ve a la pestaña **Actions** de tu repositorio.
El proceso dura ~5 minutos.

### 4. Descargar el APK
Cuando el workflow termine (ícono verde ✓):
1. Haz clic en el workflow completado
2. Baja hasta "Artifacts"
3. Descarga \`WormGPT-debug\`
4. Extrae el ZIP y tendrás el APK

### 5. Instalar en Android
1. Copia el APK a tu teléfono
2. Activa "Instalar apps de fuentes desconocidas" en Ajustes
3. Abre el APK y toca "Instalar"

## Soporte
El APK de debug ya está firmado con una clave de debug y se puede instalar directamente.
Para publicar en Play Store necesitarías generar una clave de firma.
`;
    zip.addFile('README.md', Buffer.from(readme, 'utf8'));
    const buf = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="wormgpt-android-project.zip"');
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Static / Fallback ────────────────────────────────────────────────────────
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
