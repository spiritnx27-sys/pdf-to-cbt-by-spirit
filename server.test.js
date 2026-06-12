const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { ...options, headers: { ...(options.headers || {}) } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : null, raw: data });
        } catch (error) {
          resolve({ status: res.statusCode || 0, body: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function waitForServer(url, timeout = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryFetch = () => {
      requestJson(url)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() - start > timeout) {
            reject(new Error(`Server did not start at ${url}`));
          } else {
            setTimeout(tryFetch, 100);
          }
        });
    };
    tryFetch();
  });
}

test('raw text upload produces a structured CBT quiz', async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '5102' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  await waitForServer('http://127.0.0.1:5102/');

  const uploadRes = await requestJson('http://127.0.0.1:5102/api/spirit/upload-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '1. What is the capital of France?\nA. London\nB. Paris\nC. Rome\nD. Berlin\n\n2. What is 2 + 2?\nA. 3\nB. 4\nC. 5\nD. 6'
    })
  });

  assert.equal(uploadRes.status, 200);
  assert.ok(Array.isArray(uploadRes.body.quiz));
  assert.equal(uploadRes.body.quiz.length, 2);
  assert.equal(uploadRes.body.quiz[0].options.length, 4);
  assert.ok(uploadRes.body.quiz[0].topicKeywords.length > 0);

  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
});

test('pdf upload endpoint returns a structured CBT quiz', async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '5103' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  await waitForServer('http://127.0.0.1:5103/');

  const pdfBuffer = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 18 Tf 72 72 Td (Sample question one) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000062 00000 n 
0000000119 00000 n 
0000000206 00000 n 
0000000304 00000 n 
trailer
<< /Root 1 0 R /Size 6 >>
%%EOF`);

  const formData = new FormData();
  formData.append('pdfFile', new Blob([pdfBuffer], { type: 'application/pdf' }), 'sample.pdf');

  const uploadRes = await fetch('http://127.0.0.1:5103/api/upload-pdf', {
    method: 'POST',
    body: formData
  });
  const uploadBody = await uploadRes.json();

  assert.equal(uploadRes.status, 200);
  assert.ok(Array.isArray(uploadBody.quiz));
  assert.ok(uploadBody.quiz.length > 0);

  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
});

test('login endpoint issues a token, signup creates a user, and convert rejects empty upload', async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '5101' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  await waitForServer('http://127.0.0.1:5101/');

  const signupRes = await requestJson('http://127.0.0.1:5101/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'newcandidate',
      password: 'secure123',
      confirmPassword: 'secure123',
      fullName: 'Ari Carter',
      email: 'ari@example.com'
    })
  });
  assert.equal(signupRes.status, 201);
  assert.ok(signupRes.body.token, 'expected a JWT token after signup');
  assert.equal(signupRes.body.user.fullName, 'Ari Carter');
  assert.equal(signupRes.body.user.email, 'ari@example.com');

  const forgotPasswordRes = await requestJson('http://127.0.0.1:5101/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'newcandidate', email: 'ari@example.com' })
  });
  assert.equal(forgotPasswordRes.status, 200);
  assert.match(forgotPasswordRes.body.message, /temporary password|reset/i);

  const tempPasswordMatch = forgotPasswordRes.body.message.match(/([A-Za-z]+\d{4})/);
  assert.ok(tempPasswordMatch, 'expected a temporary password in the reset message');

  const loginRes = await requestJson('http://127.0.0.1:5101/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'newcandidate', password: tempPasswordMatch[1] })
  });
  const loginBody = loginRes.body;
  assert.equal(loginRes.status, 200);
  assert.ok(loginBody.token, 'expected a JWT token');

  const convertRes = await requestJson('http://127.0.0.1:5101/api/spirit/convert', { method: 'POST' });
  const convertBody = convertRes.body;
  assert.equal(convertRes.status, 401);
  assert.match(convertBody.error, /authentication|required/i);

  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
});
