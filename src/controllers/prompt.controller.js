const fs = require('fs');
const path = require('path');
const { winstonLogger } = require('../config/logger/winston.config');

const PROMPT_FILE_PATH = path.join(__dirname, '..', 'rules', 'prompt_context.json');

exports.getPromptContext = (req, res) => {
  try {
    if (!fs.existsSync(PROMPT_FILE_PATH)) {
      // Return defaults if file doesn't exist
      return res.json({
        globalInstructions: '',
        perfectExample: ''
      });
    }
    const fileData = fs.readFileSync(PROMPT_FILE_PATH, 'utf8');
    const promptData = JSON.parse(fileData);
    res.json(promptData);
  } catch (err) {
    winstonLogger.error('Error reading prompt context file:', err);
    res.status(500).json({ error: 'Failed to read prompt context' });
  }
};

exports.updatePromptContext = (req, res) => {
  try {
    const newContext = req.body;
    
    if (!newContext || typeof newContext !== 'object') {
      return res.status(400).json({ error: 'Invalid prompt context format' });
    }

    fs.writeFileSync(PROMPT_FILE_PATH, JSON.stringify(newContext, null, 2), 'utf8');

    res.json({ message: 'Prompt context updated successfully', data: newContext });
  } catch (err) {
    winstonLogger.error('Error updating prompt context file:', err);
    res.status(500).json({ error: 'Failed to update prompt context' });
  }
};
