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

const app = express();
const mongoose = require('mongoose');

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => winstonLogger.info('Connected to MongoDB'))
    .catch(err => winstonLogger.error('MongoDB connection error:', err));
}


// Security & Middleware
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('http://localhost') || origin === process.env.CLIENT_URL) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
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
apiRouter.use('/projects', projectsRouter);
apiRouter.use('/errortypes', errorTypesRouter);

app.use('/api/v1', apiRouter);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  winstonLogger.info(`🚀 QA Automation Express Server listening on port ${PORT}`);
  console.log(`🚀 QA Automation Express Server listening on port ${PORT}`);
});
