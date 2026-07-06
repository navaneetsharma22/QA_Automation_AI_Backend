/**
 * QA Automation Backend Bootstrap (Express + Mongoose + Winston)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { winstonLogger } = require('./config/logger/winston.config');
const analyzeRouter = require('./routes/analyze.routes');
const rulesRouter = require('./routes/rules.routes');
const promptRouter = require('./routes/prompt.routes');
const usersRouter = require('./routes/users.routes');
const projectsRouter = require('./routes/projects.routes');
const errorTypesRouter = require('./routes/errorTypes.routes');
const crmRouter = require('./routes/crm.routes');
const qcRouter = require('./routes/qc.routes');

const app = express();
const mongoose = require('mongoose');

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => winstonLogger.info('Connected to MongoDB'))
    .catch(err => winstonLogger.error('MongoDB connection error:', err));
}


// Security & Middleware — Manual CORS to guarantee preflight works
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || origin.startsWith('http://localhost') || origin === process.env.CLIENT_URL) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-use-personal-keys,x-groq-key,x-openai-key,x-anthropic-key,x-gemini-key,x-deepseek-key,x-openrouter-key,x-huggingface-key,x-cerebras-key,x-cohere-key,x-github-key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Immediately respond to preflight
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// Global Prefix route structure
const apiRouter = express.Router();

apiRouter.get('/', (req, res) => {
  res.json({ message: 'Welcome to QA Automation REST API' });
});

// Add your module routes here
apiRouter.use('/analyze', analyzeRouter);
apiRouter.use('/rules', rulesRouter);
apiRouter.use('/prompt', promptRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/projects', projectsRouter);
apiRouter.use('/errortypes', errorTypesRouter);
apiRouter.use('/crm', crmRouter);
apiRouter.use('/qc', qcRouter);

app.use('/api/v1', apiRouter);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  winstonLogger.info(`🚀 QA Automation Express Server listening on port ${PORT}`);
  console.log(`🚀 QA Automation Express Server listening on port ${PORT}`);
});
