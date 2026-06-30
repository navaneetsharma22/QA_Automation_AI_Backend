const express = require('express');
const router = express.Router();
const crmController = require('../controllers/crm.controller');

// Get all chats from CRM (paginated)
router.get('/chats', crmController.getChats);

// Get a specific chat transcript by ID
router.get('/chats/:id/transcript', crmController.getChatTranscript);

module.exports = router;
