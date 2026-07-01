const { winstonLogger } = require('../config/logger/winston.config');
const axios = require('axios'); // Requires 'axios' to be installed

exports.getChats = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const requestedDate = req.query.date;
    
    const token = process.env.CRM_ACCESS_TOKEN;
    const baseUrl = process.env.CRM_API_URL;
    
    console.log(`[DEBUG] CRM Route Hit! Page: ${page}, Date: ${requestedDate || 'None'}`);

    // If no token or URL is set, return empty structure safely
    if (!token || token === 'your_access_token_here' || !baseUrl || baseUrl === 'https://your-crm-api.com/v1') {
      return res.status(200).json({ total: 0, totalPages: 1, data: [] });
    }

    let fetchUrl = baseUrl;
    if (!fetchUrl.includes('?')) {
      if (!fetchUrl.endsWith('/query/all')) {
         fetchUrl = `${fetchUrl.replace(/\/$/, '')}/query/all`;
      }
      fetchUrl = `${fetchUrl}?page=${page}&limit=${limit}&sort=createdAt:desc`;
      if (requestedDate) {
        fetchUrl += `&date=${requestedDate}`;
      }
    }

    const response = await axios.get(fetchUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    let chatsArray = response.data?.data?.all || [];
    
    // Fallback manual filter in case the mock/CRM API doesn't process the 'date' query param natively
    if (requestedDate && Array.isArray(chatsArray)) {
      chatsArray = chatsArray.filter(chat => {
        const chatDateStr = chat.createdAt || chat.created_at || chat.date || new Date().toISOString();
        const chatDateOnly = new Date(chatDateStr).toISOString().split('T')[0];
        return chatDateOnly === requestedDate;
      });
    }
    
    const results = {
      total: response.data?.pagination?.total || chatsArray.length || 0,
      totalPages: response.data?.pagination?.pages || 1,
      data: Array.isArray(chatsArray) ? chatsArray.map(chat => ({
         // Keep real PET IDs for fetching
         id: chat.petitionId || chat._id || chat.id || chat.queryId || 'N/A',
         // Restore all the original fallbacks
         customerName: chat.customerName || chat.customer_name || (chat.customer && chat.customer.name) || 'Customer',
         agentName: chat.agentName || chat.agent_name || (chat.agent && chat.agent.name) || (chat.assignedTo && chat.assignedTo.name) || 'System',
         date: chat.createdAt || chat.created_at || new Date().toISOString(),
         category: chat.category || chat.topic || chat.type || chat.subject || 'General'
      })) : []
    };

    res.status(200).json(results);
  } catch (error) {
    winstonLogger.error('Error fetching CRM chats:', error.message);
    res.status(500).json({ error: 'Failed to fetch CRM chats' });
  }
};

exports.getChatTranscript = async (req, res) => {
  try {
    const { id } = req.params;
    const token = process.env.CRM_ACCESS_TOKEN;
    const baseUrl = process.env.CRM_API_URL;
    
    if (!token || token === 'your_access_token_here' || !baseUrl) {
      return res.status(200).json({ transcript: '' });
    }

    let baseEndpoint = baseUrl.split('?')[0];
    let fetchUrl = '';
    
    if (baseEndpoint.endsWith('/query/all')) {
      fetchUrl = baseEndpoint.replace('/query/all', `/query/${id}`);
    } else {
      fetchUrl = `${baseEndpoint.replace(/\/$/, '')}/${id}`;
    }

    console.log(`[DEBUG TRANSCRIPT] Calling CRM API for Transcript: ${fetchUrl}`);

    const response = await axios.get(fetchUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    let transcript = '';
    const msgs = response.data?.data?.messages || [];
    
    if (Array.isArray(msgs) && msgs.length > 0) {
      msgs.forEach(msg => {
         // Specifically matching ODILIA's structure
         // e.g. "timestamp": "2026-06-30T12:17:29.060Z", "senderName": "Amy Burgess", "message": "..."
         let time = '00:00';
         if (msg.timestamp) {
             const dateObj = new Date(msg.timestamp);
             time = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
         }
         
         const sender = msg.senderName || msg.sender_name || 'Unknown';
         const text = msg.message || msg.text || '';
         
         transcript += `[${time}] ${sender}: ${text}\n`;
      });
    }

    res.status(200).json({ transcript });
  } catch (error) {
    winstonLogger.error('Error fetching CRM transcript:', error.message);
    res.status(500).json({ error: 'Failed to fetch CRM transcript' });
  }
};
