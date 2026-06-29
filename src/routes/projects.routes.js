const express = require('express');
const router = express.Router();
const projectsController = require('../controllers/projects.controller');

router.post('/', projectsController.createProject);
router.get('/', projectsController.getProjects);
router.get('/:id', projectsController.getProjectById);
router.put('/:id', projectsController.updateProject);
router.delete('/:id', projectsController.deleteProject);

module.exports = router;
