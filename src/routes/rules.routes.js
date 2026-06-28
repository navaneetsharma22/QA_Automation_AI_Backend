const express = require('express');
const router = express.Router();
const rulesController = require('../controllers/rules.controller');

router.get('/', rulesController.getRules);
router.post('/', rulesController.addRuleCategory);
router.put('/:id', rulesController.updateRuleCategory);
router.delete('/:id', rulesController.deleteRuleCategory);

module.exports = router;
