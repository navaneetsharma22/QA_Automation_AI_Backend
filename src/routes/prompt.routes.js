const express = require('express');
const router = express.Router();
const promptController = require('../controllers/prompt.controller');

router.get('/', promptController.getPromptContext);
router.put('/', promptController.updatePromptContext);

module.exports = router;
