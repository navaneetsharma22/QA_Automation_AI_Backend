const { Project } = require('../database/schemas/all-schemas');
const { winstonLogger } = require('../config/logger/winston.config');

exports.createProject = async (req, res) => {
  try {
    const { name, description, cards } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Project name is required' });
    }

    const newProject = new Project({
      name,
      description,
      cards: cards || []
    });

    await newProject.save();
    res.status(201).json({ message: 'Project created successfully', project: newProject });
  } catch (err) {
    winstonLogger.error('Error creating project:', err);
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Project with this name already exists' });
    }
    res.status(500).json({ error: 'Failed to create project' });
  }
};

exports.getProjects = async (req, res) => {
  try {
    const projects = await Project.find().sort({ createdAt: -1 });
    res.json(projects);
  } catch (err) {
    winstonLogger.error('Error fetching projects:', err);
    res.status(500).json({ error: 'Failed to fetch projects', details: err.message });
  }
};

exports.getProjectById = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) {
    winstonLogger.error('Error fetching project:', err);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
};

exports.updateProject = async (req, res) => {
  try {
    const { name, description, cards, status } = req.body;
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { name, description, cards, status, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );

    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ message: 'Project updated successfully', project });
  } catch (err) {
    winstonLogger.error('Error updating project:', err);
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Project with this name already exists' });
    }
    res.status(500).json({ error: 'Failed to update project' });
  }
};

exports.deleteProject = async (req, res) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ message: 'Project deleted successfully' });
  } catch (err) {
    winstonLogger.error('Error deleting project:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
};
