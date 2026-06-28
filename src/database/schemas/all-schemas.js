/**
 * QA Automation MongoDB Mongoose Schemas
 * Collections: Users, Chat Analysis, Prompt Templates, Prompt Versions,
 * Knowledge Base, Embeddings, Reports, Dashboard Statistics, Logs, Settings
 */
const mongoose = require('mongoose');

// 1. Users Schema
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
  fullName: { type: String, required: true },
  role: { type: String, enum: ['Admin', 'User'], default: 'User' },
  avatarUrl: { type: String, default: '' },
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// 2. Chat Analysis Schema
const ChatAnalysisSchema = new mongoose.Schema({
  analysisId: { type: String, required: true, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  conversationText: { type: String, required: true },
  aiProvider: { type: String, required: true },
  aiModel: { type: String, required: true },
  promptVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromptVersion' },
  status: { type: String, enum: ['Successful', 'Failed', 'Processing'], default: 'Processing' },
  qaScore: { type: Number, default: 0 },
  misleadingPercentage: { type: Number, default: 0 },
  processingTimeMs: { type: Number, default: 0 },
  reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'Report' },
  createdAt: { type: Date, default: Date.now }
});

// 3. Prompt Templates Schema
const PromptTemplateSchema = new mongoose.Schema({
  promptName: { type: String, required: true, unique: true },
  description: { type: String, default: '' },
  aiProvider: { type: String, default: 'OpenAI' },
  activeVersion: { type: Number, default: 1 },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  createdDate: { type: Date, default: Date.now },
  updatedDate: { type: Date, default: Date.now }
});

// 4. Prompt Versions Schema
const PromptVersionSchema = new mongoose.Schema({
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromptTemplate', required: true },
  versionNumber: { type: Number, required: true },
  promptContent: { type: String, required: true },
  changelog: { type: String, default: 'Initial creation' },
  isActive: { type: Boolean, default: true },
  createdDate: { type: Date, default: Date.now }
});

// 5. Knowledge Base Schema (RAG)
const KnowledgeBaseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  category: { type: String, default: 'Company Policies' },
  content: { type: String, required: true },
  status: { type: String, enum: ['Active', 'Draft', 'Archived'], default: 'Active' },
  fileType: { type: String, default: 'text/plain' },
  chunkCount: { type: Number, default: 1 },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// 6. Embeddings Schema
const EmbeddingSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeBase', required: true },
  chunkIndex: { type: Number, required: true },
  textChunk: { type: String, required: true },
  vector: [{ type: Number }], // Vector embedding array
  createdAt: { type: Date, default: Date.now }
});

// 7. Reports Schema
const ReportSchema = new mongoose.Schema({
  analysisId: { type: String, required: true, unique: true },
  chatInfo: {
    analysisId: String,
    dateTime: Date,
    aiModelUsed: String,
    promptVersion: String,
    processingTime: String
  },
  overallSummary: {
    overallQaScore: Number,
    overallStatus: { type: String, enum: ['Passed', 'Warning', 'Failed'] },
    totalIssues: Number,
    overallRecommendation: String
  },
  findings: [{
    issueTitle: String,
    category: String,
    severity: { type: String, enum: ['Critical', 'High', 'Medium', 'Low', 'Informational'] },
    conversationEvidence: String,
    aiExplanation: String,
    whyIncorrect: String,
    correctResponseSuggestion: String,
    confidenceScore: Number
  }],
  createdAt: { type: Date, default: Date.now }
});

// 8. Dashboard Statistics Schema
const DashboardStatisticsSchema = new mongoose.Schema({
  statDate: { type: String, unique: true }, // 'YYYY-MM-DD'
  totalChatsAnalyzed: { type: Number, default: 0 },
  successfulAnalysis: { type: Number, default: 0 },
  failedAnalysis: { type: Number, default: 0 },
  misleadingPercentage: { type: Number, default: 0 },
  averageQaScore: { type: Number, default: 0 },
  averageAiResponseTimeMs: { type: Number, default: 0 },
  aiModelUsage: { type: Map, of: Number, default: {} },
  totalReportsGenerated: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

// 9. Logs Schema
const LogSchema = new mongoose.Schema({
  level: { type: String, enum: ['info', 'warn', 'error'], required: true },
  message: { type: String, required: true },
  context: { type: String, default: 'System' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  metadata: { type: Object, default: {} },
  timestamp: { type: Date, default: Date.now }
});

// 10. Settings Schema
const SettingsSchema = new mongoose.Schema({
  orgName: { type: String, default: 'QA Automation Org' },
  defaultAiProvider: { type: String, default: 'GROQ' },
  defaultAiModel: { type: String, default: 'llama-3.3-70b-versatile' },
  minPassingScore: { type: Number, default: 85 },
  ragEnabled: { type: Boolean, default: true },
  retrievalTopK: { type: Number, default: 4 },
  maxConcurrentAnalyses: { type: Number, default: 10 },
  webhookNotifications: { type: Boolean, default: false },
  webhookUrl: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = {
  User: mongoose.models.User || mongoose.model('User', UserSchema),
  ChatAnalysis: mongoose.models.ChatAnalysis || mongoose.model('ChatAnalysis', ChatAnalysisSchema),
  PromptTemplate: mongoose.models.PromptTemplate || mongoose.model('PromptTemplate', PromptTemplateSchema),
  PromptVersion: mongoose.models.PromptVersion || mongoose.model('PromptVersion', PromptVersionSchema),
  KnowledgeBase: mongoose.models.KnowledgeBase || mongoose.model('KnowledgeBase', KnowledgeBaseSchema),
  Embedding: mongoose.models.Embedding || mongoose.model('Embedding', EmbeddingSchema),
  Report: mongoose.models.Report || mongoose.model('Report', ReportSchema),
  DashboardStatistics: mongoose.models.DashboardStatistics || mongoose.model('DashboardStatistics', DashboardStatisticsSchema),
  Log: mongoose.models.Log || mongoose.model('Log', LogSchema),
  Settings: mongoose.models.Settings || mongoose.model('Settings', SettingsSchema)
};
