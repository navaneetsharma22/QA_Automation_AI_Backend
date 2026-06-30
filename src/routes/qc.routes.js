const express = require('express');
const router = express.Router();
const { postToQC } = require('../controllers/qc.controller');

// POST /api/v1/qc/post-report
router.post('/post-report', postToQC);

module.exports = router;
