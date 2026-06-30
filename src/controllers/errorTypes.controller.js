const fs = require('fs');
const path = require('path');
const { winstonLogger } = require('../config/logger/winston.config');

const ERROR_TYPES_FILE_PATH = path.join(__dirname, '..', 'rules', 'error_types.json');

exports.getErrorTypes = (req, res) => {
  try {
    if (!fs.existsSync(ERROR_TYPES_FILE_PATH)) {
      fs.writeFileSync(ERROR_TYPES_FILE_PATH, JSON.stringify([], null, 2), 'utf8');
      return res.json([]);
    }
    const fileData = fs.readFileSync(ERROR_TYPES_FILE_PATH, 'utf8');
    const errorTypes = JSON.parse(fileData);
    res.json(errorTypes);
  } catch (err) {
    winstonLogger.error('Error reading error types file:', err);
    res.status(500).json({ error: 'Failed to read error types' });
  }
};

exports.addErrorType = (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const fileData = fs.existsSync(ERROR_TYPES_FILE_PATH) ? fs.readFileSync(ERROR_TYPES_FILE_PATH, 'utf8') : '[]';
    const errorTypes = JSON.parse(fileData);

    const newErrorType = {
      id: name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
      name: name,
      description: description
    };

    // Prevent exact duplicates by ID
    if (errorTypes.some(et => et.id === newErrorType.id)) {
        return res.status(400).json({ error: 'Error type with this name already exists' });
    }

    errorTypes.push(newErrorType);

    fs.writeFileSync(ERROR_TYPES_FILE_PATH, JSON.stringify(errorTypes, null, 2), 'utf8');

    res.json({ message: 'Error type added successfully', newErrorType });
  } catch (err) {
    winstonLogger.error('Error updating error types file:', err);
    res.status(500).json({ error: 'Failed to add error type' });
  }
};

exports.updateErrorType = (req, res) => {
  try {
    const errorTypeId = req.params.id;
    const { name, description } = req.body;

    if (!name || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!fs.existsSync(ERROR_TYPES_FILE_PATH)) {
        return res.status(404).json({ error: 'Error type not found' });
    }

    const fileData = fs.readFileSync(ERROR_TYPES_FILE_PATH, 'utf8');
    const errorTypes = JSON.parse(fileData);

    const typeIndex = errorTypes.findIndex((et) => et.id === errorTypeId);
    
    if (typeIndex === -1) {
      return res.status(404).json({ error: 'Error type not found' });
    }

    errorTypes[typeIndex] = {
      ...errorTypes[typeIndex],
      name,
      description
    };

    fs.writeFileSync(ERROR_TYPES_FILE_PATH, JSON.stringify(errorTypes, null, 2), 'utf8');

    res.json({ message: 'Error type updated successfully', updatedErrorType: errorTypes[typeIndex] });
  } catch (err) {
    winstonLogger.error('Error updating error type:', err);
    res.status(500).json({ error: 'Failed to update error type' });
  }
};

exports.deleteErrorType = (req, res) => {
  try {
    const errorTypeId = req.params.id;

    if (!fs.existsSync(ERROR_TYPES_FILE_PATH)) {
        return res.status(404).json({ error: 'Error type not found' });
    }

    const fileData = fs.readFileSync(ERROR_TYPES_FILE_PATH, 'utf8');
    const errorTypes = JSON.parse(fileData);

    const initialLength = errorTypes.length;
    const filteredTypes = errorTypes.filter((et) => et.id !== errorTypeId);

    if (filteredTypes.length === initialLength) {
      return res.status(404).json({ error: 'Error type not found' });
    }

    fs.writeFileSync(ERROR_TYPES_FILE_PATH, JSON.stringify(filteredTypes, null, 2), 'utf8');

    res.json({ message: 'Error type deleted successfully' });
  } catch (err) {
    winstonLogger.error('Error deleting error type:', err);
    res.status(500).json({ error: 'Failed to delete error type' });
  }
};
