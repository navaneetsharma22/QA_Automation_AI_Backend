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

const app = express();

// Security & Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  credentials: true,
}));
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

app.use('/api/v1', apiRouter);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  winstonLogger.info(`🚀 QA Automation Express Server listening on port ${PORT}`);
  console.log(`🚀 QA Automation Express Server listening on port ${PORT}`);
});
