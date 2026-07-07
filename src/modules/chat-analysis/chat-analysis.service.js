/**
 * Chat Analysis Service - Core QA Pipeline
 * Delegates to the real analyze.controller logic via the exported analyzeChat handler.
 */
const { analyzeChat } = require('../../controllers/analyze.controller');

class ChatAnalysisService {
  /**
   * Thin wrapper so other modules can call the QA engine programmatically.
   * Builds a minimal req/res shim and delegates to the real controller.
   */
  async analyzeConversation(user, conversationText, aiProviderKey, aiModel) {
    return new Promise((resolve, reject) => {
      const req = {
        body: { conversationText, aiProvider: aiProviderKey, aiModel },
        headers: {}
      };
      const res = {
        status(code) { this._code = code; return this; },
        json(data) {
          if (this._code && this._code >= 400) return reject(new Error(data.error || 'Analysis failed'));
          resolve(data);
        }
      };
      analyzeChat(req, res).catch(reject);
    });
  }
}

module.exports = { ChatAnalysisService };
