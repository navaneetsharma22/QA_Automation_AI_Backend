const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { winstonLogger } = require('../config/logger/winston.config');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_2026_dev';
const JWT_EXPIRES_IN = '15h';

const USERS_FILE_PATH = path.join(__dirname, '..', 'rules', 'users.json');

const getUsersData = () => {
  try {
    if (!fs.existsSync(USERS_FILE_PATH)) return [];
    const fileData = fs.readFileSync(USERS_FILE_PATH, 'utf8');
    return JSON.parse(fileData) || [];
  } catch (err) {
    winstonLogger.error('Error reading users file:', err);
    return [];
  }
};

const saveUsersData = (data) => {
  fs.writeFileSync(USERS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
};

exports.createUser = (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const users = getUsersData();
    
    // Check if email already exists
    if (users.some(u => u.email === email)) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const newUser = {
      id: 'usr_' + Math.random().toString(36).substr(2, 9),
      fullName,
      email,
      password,
      role: 'User',
      sidebarAccess: req.body.sidebarAccess || ['dashboard', 'crm-chats', 'analyze', 'history', 'reports', 'prompts', 'knowledge', 'models', 'analytics', 'settings', 'profile'],
      isBlocked: false,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsersData(users);

    res.status(201).json({ message: 'User created successfully', user: { ...newUser, password: undefined } });
  } catch (err) {
    winstonLogger.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
};

exports.loginUser = (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const users = getUsersData();
    const user = users.find(u => u.email === email && u.password === password);

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.isBlocked) {
      return res.status(403).json({ error: 'Your account has been suspended. Please contact the administrator.' });
    }

    const payload = { id: user.id, email: user.email, role: user.role };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    const expiresAt = Date.now() + 15 * 60 * 60 * 1000; // 15 hours in ms

    res.json({
      message: 'Login successful',
      token,
      expiresAt,
      user: { ...user, password: undefined, token, expiresAt }
    });
  } catch (err) {
    winstonLogger.error('Error logging in:', err);
    res.status(500).json({ error: 'Failed to login' });
  }
};

exports.getAllUsers = (req, res) => {
  try {
    const users = getUsersData();
    const safeUsers = users.map(u => ({ ...u, password: undefined }));
    res.json(safeUsers);
  } catch (err) {
    winstonLogger.error('Error getting users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

exports.updateUser = (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, email, password, isBlocked, sidebarAccess } = req.body;
    const users = getUsersData();
    const index = users.findIndex(u => u.id === id);

    if (index === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (email && email !== users[index].email && users.some(u => u.email === email && u.id !== id)) {
      return res.status(409).json({ error: 'Another user with this email already exists' });
    }

    // Protection removed per user request

    users[index] = {
      ...users[index],
      ...(fullName && { fullName }),
      ...(email && { email }),
      ...(password && { password }),
      ...(typeof isBlocked === 'boolean' && { isBlocked }),
      ...(sidebarAccess && { sidebarAccess })
    };

    saveUsersData(users);
    res.json({ message: 'User updated successfully', user: { ...users[index], password: undefined } });
  } catch (err) {
    winstonLogger.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

exports.deleteUser = (req, res) => {
  try {
    const { id } = req.params;
    const users = getUsersData();
    const user = users.find(u => u.id === id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Protection removed per user request

    const filteredUsers = users.filter(u => u.id !== id);
    saveUsersData(filteredUsers);
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    winstonLogger.error('Error deleting user:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};
