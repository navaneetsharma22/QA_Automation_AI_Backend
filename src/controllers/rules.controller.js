const fs = require('fs');
const path = require('path');
const { winstonLogger } = require('../config/logger/winston.config');

const RULES_FILE_PATH = path.join(__dirname, '..', 'rules', 'corendon_rules.json');

exports.getRules = (req, res) => {
  try {
    const fileData = fs.readFileSync(RULES_FILE_PATH, 'utf8');
    const rules = JSON.parse(fileData);
    res.json(rules);
  } catch (err) {
    winstonLogger.error('Error reading rules file:', err);
    res.status(500).json({ error: 'Failed to read rules' });
  }
};

exports.addRuleCategory = (req, res) => {
  try {
    const { category, description } = req.body;
    
    if (!category || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const fileData = fs.readFileSync(RULES_FILE_PATH, 'utf8');
    const rulesConfig = JSON.parse(fileData);

    const newRule = {
      id: category.toLowerCase().replace(/\s+/g, '_'),
      category: category,
      description: description,
      detection_checks: [
        "Compare customer intent with agent response",
        "Verify against official policy"
      ]
    };

    // Add category to global checks if not exists
    if (!rulesConfig.global_checks.includes(category)) {
      rulesConfig.global_checks.push(category);
    }

    // Add rule object
    if (!rulesConfig.rules) {
      rulesConfig.rules = [];
    }
    rulesConfig.rules.push(newRule);

    fs.writeFileSync(RULES_FILE_PATH, JSON.stringify(rulesConfig, null, 2), 'utf8');

    res.json({ message: 'Rule added successfully', newRule });
  } catch (err) {
    winstonLogger.error('Error updating rules file:', err);
    res.status(500).json({ error: 'Failed to update rules' });
  }
};

exports.updateRuleCategory = (req, res) => {
  try {
    const ruleId = req.params.id;
    const { category, description } = req.body;

    if (!category || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const fileData = fs.readFileSync(RULES_FILE_PATH, 'utf8');
    const rulesConfig = JSON.parse(fileData);

    const ruleIndex = rulesConfig.rules?.findIndex((r) => r.id === ruleId);
    
    if (ruleIndex === -1 || ruleIndex === undefined) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    rulesConfig.rules[ruleIndex] = {
      ...rulesConfig.rules[ruleIndex],
      category,
      description
    };

    fs.writeFileSync(RULES_FILE_PATH, JSON.stringify(rulesConfig, null, 2), 'utf8');

    res.json({ message: 'Rule updated successfully', updatedRule: rulesConfig.rules[ruleIndex] });
  } catch (err) {
    winstonLogger.error('Error updating rule:', err);
    res.status(500).json({ error: 'Failed to update rule' });
  }
};

exports.deleteRuleCategory = (req, res) => {
  try {
    const ruleId = req.params.id;

    const fileData = fs.readFileSync(RULES_FILE_PATH, 'utf8');
    const rulesConfig = JSON.parse(fileData);

    const initialLength = rulesConfig.rules?.length || 0;
    
    if (rulesConfig.rules) {
      rulesConfig.rules = rulesConfig.rules.filter((r) => r.id !== ruleId);
    }

    if (rulesConfig.rules?.length === initialLength) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    fs.writeFileSync(RULES_FILE_PATH, JSON.stringify(rulesConfig, null, 2), 'utf8');

    res.json({ message: 'Rule deleted successfully' });
  } catch (err) {
    winstonLogger.error('Error deleting rule:', err);
    res.status(500).json({ error: 'Failed to delete rule' });
  }
};
