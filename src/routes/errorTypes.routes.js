const express = require('express');
const router = express.Router();
const errorTypesController = require('../controllers/errorTypes.controller');

router.get('/', errorTypesController.getErrorTypes);
router.post('/', errorTypesController.addErrorType);
router.put('/:id', errorTypesController.updateErrorType);
router.delete('/:id', errorTypesController.deleteErrorType);

module.exports = router;
