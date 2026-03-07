'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const busboy = require('busboy');

const execFileAsync = promisify(execFile);

const PORT = parseInt(process.env.PORT || '3000', 10);
const DITA_OT_HOME = process.env.DITA_OT_HOME || '/opt/dita-ot';
const DITA_BIN = path.join(DITA_OT_HOME, 'bin', 'dita');
const API_KEY = process.env.DITA_OT_API_KEY || '';
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '4', 10);
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '300000', 10);
const JOBS_DIR = '/tmp/dita-jobs';

const ALLOWED_FORMATS = new Set(['html5', 'pdf', 'epub']);

let activeJobs = 0;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function checkAuth(req, res) {
  if (!API_KEY) return true;
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (provided !== API_KEY) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

function parseQuery(urlStr) {
  const idx = urlStr.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(urlStr.slice(idx + 1)));
}

async function readUploadedZip(req) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const bb = busboy({ headers: req.headers, limits: { fileSize: 256 * 1024 * 1024 } });
    const chunks = [];

    bb.on('file', (_fieldname, file, _info) => {
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', () => {
        if (!resolved) {
          resolved = true;
          resolve(Buffer.concat(chunks));
        }
      });
      file.on('error', reject);
    });

    bb.on('error', reject);
    bb.on('finish', () => {
      if (!resolved) {
        resolved = true;
        resolve(Buffer.concat(chunks));
      }
    });

    req.pipe(bb);
  });
}

async function extractZip(zipBuffer, destDir) {
  const zipPath = path.join(destDir, 'content.zip');
  await fsp.writeFile(zipPath, zipBuffer);
  await execFileAsync('unzip', ['-q', zipPath, '-d', destDir]);
  await fsp.unlink(zipPath);
}

async function zipDirectory(sourceDir, outputPath) {
  await execFileAsync('zip', ['-r', '-q', outputPath, '.'], { cwd: sourceDir });
}

function buildDitaArgs(mapPath, format, outputDir, ditavalPath) {
  const args = [
    '-i', mapPath,
    '-f', format,
    '-o', outputDir,
    '--args.input.dir', path.dirname(mapPath),
  ];
  if (ditavalPath) {
    args.push('--args.filter', ditavalPath);
  }
  return args;
}

async function runDitaOt(mapPath, format, outputDir, ditavalPath) {
  const args = buildDitaArgs(mapPath, format, outputDir, ditavalPath);
  return new Promise((resolve, reject) => {
    const proc = execFile(
      DITA_BIN,
      args,
      { timeout: JOB_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || stdout || err.message || 'DITA-OT failed').slice(0, 2000);
          reject(new Error(msg));
        } else {
          resolve(stdout);
        }
      }
    );
    proc.on('error', reject);
  });
}

async function streamFileToUrl(filePath, uploadUrl, contentType) {
  const stat = await fsp.stat(filePath);
  const fileStream = fs.createReadStream(filePath);
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
    },
    body: fileStream,
    duplex: 'half',
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return stat.size;
}

async function handleConvertAndUpload(req, res) {
  if (!checkAuth(req, res)) return;

  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return sendJson(res, 503, { error: 'Too many concurrent jobs. Try again shortly.' });
  }

  const query = parseQuery(req.url);
  const format = (query.format || '').toLowerCase();
  const ditavalParam = query.ditaval || '';
  const uploadUrl = query.upload_url ? decodeURIComponent(query.upload_url) : '';
  const uploadPath = query.upload_path ? decodeURIComponent(query.upload_path) : '';

  if (!ALLOWED_FORMATS.has(format)) {
    return sendJson(res, 400, { error: `Invalid format. Allowed: ${[...ALLOWED_FORMATS].join(', ')}` });
  }
  if (!uploadUrl) {
    return sendJson(res, 400, { error: 'upload_url query parameter is required' });
  }
  if (ditavalParam && !/^[\w.\-]+$/.test(ditavalParam)) {
    return sendJson(res, 400, { error: 'Invalid ditaval filename' });
  }

  activeJobs++;
  const jobId = randomUUID();
  const jobDir = path.join(JOBS_DIR, jobId);
  const srcDir = path.join(jobDir, 'src');
  const outDir = path.join(jobDir, 'out');

  try {
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });

    let zipBuffer;
    try {
      zipBuffer = await readUploadedZip(req);
    } catch (err) {
      return sendJson(res, 400, { error: 'Failed to read uploaded file: ' + err.message });
    }

    if (!zipBuffer || zipBuffer.length === 0) {
      return sendJson(res, 400, { error: 'No file uploaded' });
    }

    await extractZip(zipBuffer, srcDir);

    const mapPath = path.join(srcDir, 'map.ditamap');
    try {
      await fsp.access(mapPath);
    } catch {
      return sendJson(res, 400, { error: 'ZIP must contain a map.ditamap at the root' });
    }

    let ditavalPath = null;
    if (ditavalParam) {
      const candidate = path.join(srcDir, path.basename(ditavalParam));
      if (!candidate.startsWith(srcDir + path.sep)) {
        return sendJson(res, 400, { error: 'Invalid ditaval path' });
      }
      try {
        await fsp.access(candidate);
        ditavalPath = candidate;
      } catch {
        return sendJson(res, 400, { error: `Ditaval file not found in ZIP: ${ditavalParam}` });
      }
    }

    await runDitaOt(mapPath, format, outDir, ditavalPath);

    const outFiles = await fsp.readdir(outDir);
    if (outFiles.length === 0) {
      return sendJson(res, 500, { error: 'DITA-OT produced no output files' });
    }

    let outputFilePath;
    let outputMime;
    let needsCleanup = false;

    if (format === 'pdf') {
      const pdfFiles = outFiles.filter(f => f.toLowerCase().endsWith('.pdf'));
      if (pdfFiles.length === 1) {
        outputFilePath = path.join(outDir, pdfFiles[0]);
        outputMime = 'application/pdf';
      }
    }

    if (!outputFilePath && format === 'epub') {
      const epubFiles = outFiles.filter(f => f.toLowerCase().endsWith('.epub'));
      if (epubFiles.length === 1) {
        outputFilePath = path.join(outDir, epubFiles[0]);
        outputMime = 'application/epub+zip';
      }
    }

    if (!outputFilePath) {
      const resultZipPath = path.join(jobDir, 'result.zip');
      await zipDirectory(outDir, resultZipPath);
      outputFilePath = resultZipPath;
      outputMime = 'application/zip';
      needsCleanup = true;
    }

    const bytes = await streamFileToUrl(outputFilePath, uploadUrl, outputMime);

    sendJson(res, 200, {
      success: true,
      storage_path: uploadPath,
      bytes,
      format,
      mime: outputMime,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[job:${jobId}] Error:`, msg);
    if (!res.headersSent) {
      sendJson(res, 500, { error: msg });
    }
  } finally {
    activeJobs--;
    fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleConvert(req, res) {
  if (!checkAuth(req, res)) return;

  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return sendJson(res, 503, { error: 'Too many concurrent jobs. Try again shortly.' });
  }

  const query = parseQuery(req.url);
  const format = (query.format || '').toLowerCase();
  const ditavalParam = query.ditaval || '';

  if (!ALLOWED_FORMATS.has(format)) {
    return sendJson(res, 400, { error: `Invalid format. Allowed: ${[...ALLOWED_FORMATS].join(', ')}` });
  }

  if (ditavalParam && !/^[\w.\-]+$/.test(ditavalParam)) {
    return sendJson(res, 400, { error: 'Invalid ditaval filename' });
  }

  activeJobs++;
  const jobId = randomUUID();
  const jobDir = path.join(JOBS_DIR, jobId);
  const srcDir = path.join(jobDir, 'src');
  const outDir = path.join(jobDir, 'out');

  try {
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });

    let zipBuffer;
    try {
      zipBuffer = await readUploadedZip(req);
    } catch (err) {
      return sendJson(res, 400, { error: 'Failed to read uploaded file: ' + err.message });
    }

    if (!zipBuffer || zipBuffer.length === 0) {
      return sendJson(res, 400, { error: 'No file uploaded' });
    }

    await extractZip(zipBuffer, srcDir);

    const mapPath = path.join(srcDir, 'map.ditamap');
    try {
      await fsp.access(mapPath);
    } catch {
      return sendJson(res, 400, { error: 'ZIP must contain a map.ditamap at the root' });
    }

    let ditavalPath = null;
    if (ditavalParam) {
      const candidate = path.join(srcDir, path.basename(ditavalParam));
      if (!candidate.startsWith(srcDir + path.sep)) {
        return sendJson(res, 400, { error: 'Invalid ditaval path' });
      }
      try {
        await fsp.access(candidate);
        ditavalPath = candidate;
      } catch {
        return sendJson(res, 400, { error: `Ditaval file not found in ZIP: ${ditavalParam}` });
      }
    }

    await runDitaOt(mapPath, format, outDir, ditavalPath);

    const outFiles = await fsp.readdir(outDir);
    if (outFiles.length === 0) {
      return sendJson(res, 500, { error: 'DITA-OT produced no output files' });
    }

    if (format === 'pdf') {
      const pdfFiles = outFiles.filter(f => f.toLowerCase().endsWith('.pdf'));
      if (pdfFiles.length === 1) {
        const pdfPath = path.join(outDir, pdfFiles[0]);
        const pdfData = await fsp.readFile(pdfPath);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdfData.length,
          'Content-Disposition': `attachment; filename="${pdfFiles[0]}"`,
        });
        return res.end(pdfData);
      }
    }

    if (format === 'epub') {
      const epubFiles = outFiles.filter(f => f.toLowerCase().endsWith('.epub'));
      if (epubFiles.length === 1) {
        const epubPath = path.join(outDir, epubFiles[0]);
        const epubData = await fsp.readFile(epubPath);
        res.writeHead(200, {
          'Content-Type': 'application/epub+zip',
          'Content-Length': epubData.length,
          'Content-Disposition': `attachment; filename="${epubFiles[0]}"`,
        });
        return res.end(epubData);
      }
    }

    const resultZipPath = path.join(jobDir, 'result.zip');
    await zipDirectory(outDir, resultZipPath);
    const zipData = await fsp.readFile(resultZipPath);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zipData.length,
      'Content-Disposition': `attachment; filename="output-${format}.zip"`,
    });
    res.end(zipData);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[job:${jobId}] Error:`, msg);
    if (!res.headersSent) {
      sendJson(res, 500, { error: msg });
    }
  } finally {
    activeJobs--;
    fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { status: 'ok', activeJobs, maxJobs: MAX_CONCURRENT_JOBS });
  }

  if (url === '/convert' && req.method === 'POST') {
    return handleConvert(req, res);
  }

  if (url === '/convert-and-upload' && req.method === 'POST') {
    return handleConvertAndUpload(req, res);
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`DITA-OT worker listening on port ${PORT}`);
  console.log(`DITA_OT_HOME: ${DITA_OT_HOME}`);
  console.log(`Max concurrent jobs: ${MAX_CONCURRENT_JOBS}`);
  console.log(`Job timeout: ${JOB_TIMEOUT_MS}ms`);
  console.log(`API key protection: ${API_KEY ? 'enabled' : 'disabled (set DITA_OT_API_KEY to enable)'}`);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  server.close(() => process.exit(0));
});
