const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'spirit-paperless-dev-secret';
const DEFAULT_USERNAME = process.env.SPIRIT_USERNAME || 'spirit';
const DEFAULT_PASSWORD = process.env.SPIRIT_PASSWORD || 'paperless';
const DEFAULT_PASSWORD_HASH = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
const users = new Map();
users.set(DEFAULT_USERNAME, { username: DEFAULT_USERNAME, passwordHash: DEFAULT_PASSWORD_HASH });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isPdf = file?.mimetype === 'application/pdf' || (file?.originalname || '').toLowerCase().endsWith('.pdf');
    if (isPdf) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed for upload.'));
    }
  }
});

function createToken(username) {
  return jwt.sign({ sub: username, role: 'candidate' }, JWT_SECRET, { expiresIn: '8h' });
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired session token.' });
  }
}

function normalizeQuizPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'string') {
    const start = payload.indexOf('[');
    const end = payload.lastIndexOf(']');
    if (start >= 0 && end > start) {
      const jsonSlice = payload.slice(start, end + 1);
      try {
        const parsed = JSON.parse(jsonSlice);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
  }
  return [];
}

function extractFallbackQuiz(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const quiz = [];
  let currentQuestion = null;
  let currentOptions = [];
  let currentKeywords = [];

  const pushCurrent = () => {
    if (currentQuestion && currentOptions.length >= 2) {
      const normalizedOptions = currentOptions.slice(0, 4).map((entry) => entry.trim());
      const correctAnswer = normalizedOptions[0] || '';
      quiz.push({
        id: `q-${quiz.length + 1}`,
        question: currentQuestion,
        options: normalizedOptions,
        correctAnswer,
        topicKeywords: currentKeywords.length > 0 ? currentKeywords : [currentQuestion.split(' ').slice(0, 3).join(' ')]
      });
    }
    currentQuestion = null;
    currentOptions = [];
    currentKeywords = [];
  };

  for (const line of lines) {
    const questionMatch = line.match(/^(?:Question\s*\d*[:.)-]?|Q\d*[:.)-]?|\d+[.)]\s*)(.+\?)$/i);
    if (questionMatch) {
      pushCurrent();
      currentQuestion = questionMatch[1].trim();
      currentKeywords = currentQuestion.split(/\s+/).filter(Boolean).slice(0, 4);
      continue;
    }

    const optionMatch = line.match(/^(?:\(?([A-Da-d])\)?[.):-]|(?:[1-4])[.):-])\s*(.+)$/);
    if (optionMatch && currentQuestion) {
      currentOptions.push(optionMatch[2].trim());
    }

    if (/^(Answer|Correct answer|Correct)/i.test(line) && currentQuestion) {
      const answerText = line.split(':').pop().trim();
      if (answerText) {
        currentOptions.push(answerText);
      }
    }
  }

  pushCurrent();
  return quiz.slice(0, 8);
}

function extractTopicKeywords(questionText, options = []) {
  const combined = [questionText, ...options].join(' ');
  const words = combined
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !['what', 'which', 'when', 'where', 'there', 'from', 'their', 'about', 'with', 'that', 'this', 'them', 'into', 'were', 'your', 'have', 'than', 'will', 'should'].includes(word));

  const unique = [...new Set(words)].slice(0, 4);
  return unique.length > 0 ? unique : [questionText.split(' ').slice(0, 3).join(' ')];
}

function enrichQuizItems(quiz) {
  return quiz.map((entry, index) => {
    const options = Array.isArray(entry.options) ? entry.options.slice(0, 4) : [];
    const correctAnswer = entry.correctAnswer || options[0] || '';
    return {
      id: entry.id || `q-${index + 1}`,
      question: entry.question || 'Question unavailable',
      options,
      correctAnswer,
      topicKeywords: Array.isArray(entry.topicKeywords) && entry.topicKeywords.length > 0
        ? entry.topicKeywords.slice(0, 4)
        : extractTopicKeywords(entry.question || '', options)
    };
  });
}

function buildQuizFromText(rawText) {
  const quiz = extractFallbackQuiz(rawText || '');
  return enrichQuizItems(quiz);
}

async function parseTextIntoQuiz(rawText) {
  try {
    const { default: ollama } = await import('ollama');
    const response = await ollama.chat({
      model: process.env.OLLAMA_MODEL || 'llama3.2',
      messages: [
        {
          role: 'system',
          content: 'You are a strict exam parser. Convert the provided test text into a JSON array of objects with the shape [{"id":"q-1","question":"...","options":["A","B","C","D"],"correctAnswer":"...","topicKeywords":["keyword1","keyword2"]}]. Return only compact JSON.'
        },
        {
          role: 'user',
          content: rawText.substring(0, 8000)
        }
      ]
    });

    const aiOutput = response?.message?.content || '';
    const normalized = normalizeQuizPayload(aiOutput);
    if (normalized.length > 0) {
      return enrichQuizItems(normalized);
    }
  } catch (modelError) {
    console.warn('Ollama unavailable for text parsing, using fallback parser.', modelError.message || modelError);
  }

  return buildQuizFromText(rawText);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'spirit-backend' });
});

app.post('/api/auth/signup', async (req, res) => {
  const { username, password, confirmPassword, fullName, email } = req.body || {};
  const cleanUsername = (username || '').trim();
  const cleanPassword = (password || '').trim();
  const cleanConfirmPassword = (confirmPassword || '').trim();
  const cleanFullName = (fullName || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();

  if (!cleanUsername || !cleanPassword || !cleanFullName || !cleanEmail) {
    return res.status(400).json({ error: 'Please fill in your username, full name, email, and password.' });
  }

  if (cleanPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  if (cleanPassword !== cleanConfirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  if (users.has(cleanUsername)) {
    return res.status(409).json({ error: 'That username is already registered.' });
  }

  const passwordHash = await bcrypt.hash(cleanPassword, 10);
  const newUser = { username: cleanUsername, passwordHash, fullName: cleanFullName, email: cleanEmail };
  users.set(cleanUsername, newUser);

  const token = createToken(cleanUsername);
  res.status(201).json({ token, username: cleanUsername, user: newUser, message: 'Account created successfully.' });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { username, email } = req.body || {};
  const cleanUsername = (username || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();
  const storedUser = users.get(cleanUsername);

  if (!storedUser || storedUser.email !== cleanEmail) {
    return res.status(404).json({ error: 'We could not find a matching account for that username and email.' });
  }

  const tempPassword = `Spirit${Math.floor(1000 + Math.random() * 9000)}`;
  storedUser.passwordHash = await bcrypt.hash(tempPassword, 10);

  res.json({
    message: `A temporary password has been generated: ${tempPassword}`,
    username: cleanUsername
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const cleanUsername = (username || '').trim();
  const cleanPassword = (password || '').trim();
  const storedUser = users.get(cleanUsername);
  const validPassword = storedUser ? await bcrypt.compare(cleanPassword, storedUser.passwordHash) : false;

  if (!storedUser || !validPassword) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const token = createToken(cleanUsername);
  res.json({ token, username: cleanUsername, message: 'Secure session ready.' });
});

app.post('/api/spirit/upload-text', async (req, res) => {
  try {
    const rawText = req.body?.text || '';
    if (!rawText || !rawText.trim()) {
      return res.status(400).json({ error: 'Please provide raw test text to convert.' });
    }

    const quiz = await parseTextIntoQuiz(rawText);
    res.json({ quiz, source: 'text-parser' });
  } catch (error) {
    console.error('Text Upload Error:', error);
    res.status(500).json({ error: 'Could not convert the provided test text.' });
  }
});

app.post('/api/upload-pdf', upload.single('pdfFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a valid PDF file.' });
    }

    const parsedPdf = await pdfParse(req.file.buffer);
    const rawText = parsedPdf.text || '';

    if (!rawText.trim()) {
      return res.status(400).json({ error: 'The uploaded PDF did not contain readable text.' });
    }

    const quiz = await parseTextIntoQuiz(rawText);
    res.json({ quiz, source: 'pdf-upload' });
  } catch (error) {
    console.error('PDF Upload Error:', error);
    res.status(500).json({ error: 'Could not extract or parse the uploaded PDF.' });
  }
});

app.post('/api/spirit/convert', authenticate, upload.single('entrancePaper'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a clear entrance exam PDF file.' });
    }

    const parsedPdf = await pdfParse(req.file.buffer);
    const rawExamText = parsedPdf.text || '';

    let quiz = [];
    let source = 'fallback';

    try {
      const { default: ollama } = await import('ollama');
      const response = await ollama.chat({
        model: process.env.OLLAMA_MODEL || 'llama3.2',
        messages: [
          {
            role: 'system',
            content: `You are Spirit AI, an advanced exam digitizer. Convert the provided entrance paper text into a strict JSON array of quiz objects with the shape [{"question":"...","options":[...],"correctAnswer":"..."}]. Return only raw JSON. No markdown, no commentary.`
          },
          {
            role: 'user',
            content: `Convert this entrance exam text into the requested JSON array structure.\n\n${rawExamText.substring(0, 6000)}`
          }
        ]
      });

      const aiOutput = response?.message?.content || '';
      quiz = normalizeQuizPayload(aiOutput);
      if (quiz.length > 0) {
        source = 'ollama';
      }
    } catch (modelError) {
      console.warn('Ollama unavailable, using fallback parser.', modelError.message || modelError);
    }

    if (quiz.length === 0) {
      quiz = extractFallbackQuiz(rawExamText);
    }

    if (quiz.length === 0) {
      quiz = [{
        question: 'Unable to parse a question from the uploaded paper.',
        options: ['Try a clearer PDF', 'Use a document with labelled questions', 'Re-upload the exam sheet'],
        correctAnswer: 'Try a clearer PDF'
      }];
    }

    res.json({ quiz, source });
  } catch (error) {
    console.error('Spirit Backend Error:', error);
    res.status(500).json({ error: 'Spirit engine failure. Ensure Ollama is running and the PDF is readable.' });
  }
});

app.listen(PORT, () => console.log(`✨ Spirit Backend Active on http://localhost:${PORT}`));
