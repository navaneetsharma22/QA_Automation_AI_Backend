const { winstonLogger } = require('../config/logger/winston.config');
const axios = require('axios'); // Requires 'axios' to be installed
const { QcSubmission } = require('../database/schemas/all-schemas');

let isSyncingQc = false;
let lastSyncTime = 0;

const backgroundQcSync = async (qcTokenOverride) => {
  // Only sync once every 5 minutes to avoid rate limits
  if (isSyncingQc || (Date.now() - lastSyncTime < 5 * 60 * 1000)) return;
  
  isSyncingQc = true;
  try {
    const token = qcTokenOverride || process.env.QC_ACCESS_TOKEN;
    const baseUrl = process.env.QC_GET_API_URL || process.env.QC_API_URL;
    if (!token || !baseUrl) return;

    // We assume a GET to the QC API URL returns the list of past entries
    const response = await axios.get(baseUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000 // 10 second timeout
    });

    let allEntries = [];
    if (Array.isArray(response.data?.data)) allEntries = response.data.data;
    else if (Array.isArray(response.data)) allEntries = response.data;

    let count = 0;
    
    // Helper function to extract PET ID from a string
    const extractPetId = (str) => {
      if (!str) return null;
      const match = str.match(/(PET-\d+-[A-Z0-9]+)/i) || str.match(/(PET-\d+)/i);
      return match ? match[1].toUpperCase() : null;
    };

    for (const item of allEntries) {
      // If it's a grouped object that contains activityLogs
      const logsToProcess = Array.isArray(item.activityLogs) ? item.activityLogs : [item];
      
      for (const entry of logsToProcess) {
        // Extract petition ID from details string OR direct properties
        let petitionId = entry.petitionNumber || entry.petitionId || entry.id;
        
        if (!petitionId && entry.details) {
          petitionId = extractPetId(entry.details);
        }

        if (petitionId) {
          // Upsert the record locally
          await QcSubmission.findOneAndUpdate(
            { petitionId },
            { 
              petitionId, 
              submittedBy: entry.agentName || entry.submittedBy || (entry.performedBy && entry.performedBy.name) || 'QC Portal Sync',
              submittedAt: entry.createdAt || entry.timestamp || entry.date || new Date()
            },
            { upsert: true, new: true }
          );
          count++;
        }
      }
    }
    
    if (count > 0) {
      winstonLogger.info(`[QC SYNC] Successfully synced ${count} historical observations from QC Portal.`);
    }
    lastSyncTime = Date.now();
  } catch (error) {
    // If it's a 401, we just log it silently instead of flooding the console
    if (error.response?.status === 401) {
      winstonLogger.warn('[QC SYNC] QC token expired. Cannot sync historical data. Please update QC_ACCESS_TOKEN in .env');
    } else {
      winstonLogger.error('[QC SYNC] Background sync failed: ' + error.message);
    }
  } finally {
    isSyncingQc = false;
  }
};

exports.getChats = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const requestedDate = req.query.date;
    
    const token = req.headers['x-crm-token'] || process.env.CRM_ACCESS_TOKEN;
    const baseUrl = process.env.CRM_API_URL;
    
    console.log(`[DEBUG] CRM Route Hit! Page: ${page}, Date: ${requestedDate || 'None'}`);

    // If no token or URL is set, return empty structure safely
    if (!token || token === 'your_access_token_here' || !baseUrl || baseUrl === 'https://your-crm-api.com/v1') {
      return res.status(200).json({ total: 0, totalPages: 1, data: [] });
    }

    let fetchUrl = baseUrl;
    if (fetchUrl.includes('?')) {
      fetchUrl = fetchUrl.split('?')[0];
    }
    if (!fetchUrl.endsWith('/query/all')) {
       fetchUrl = `${fetchUrl.replace(/\/$/, '')}/query/all`;
    }
    // Use view=resolved so the CRM API filters before pagination, otherwise we might get empty pages after local filtering
    fetchUrl = `${fetchUrl}?page=${page}&limit=${limit}&view=resolved&sort=createdAt:desc`;
    if (requestedDate) {
      fetchUrl += `&date=${requestedDate}`;
    }

    const response = await axios.get(fetchUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    let chatsArray = response.data?.data?.all || [];
    
    // Fallback manual filter in case the mock/CRM API doesn't process the query params natively
    if (Array.isArray(chatsArray)) {
      chatsArray = chatsArray.filter(chat => {
        let isMatch = true;
        
        // Ensure we only process resolved chats
        if (chat.status && chat.status.toLowerCase() !== 'resolved') {
          isMatch = false;
        }

        if (requestedDate) {
          const chatDateStr = chat.createdAt || chat.created_at || chat.date || new Date().toISOString();
          const chatDateOnly = new Date(chatDateStr).toISOString().split('T')[0];
          if (chatDateOnly !== requestedDate) {
            isMatch = false;
          }
        }
        
        return isMatch;
      });
    }
    
    // Extract real total from CRM API if available, else fallback to array length
    const realTotal = response.data?.data?.counts?.resolved || chatsArray.length || 0;
    
    const results = {
      total: realTotal,
      totalPages: Math.ceil(realTotal / limit) || 1,
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

    // Bulk check QC Submission statuses
    if (results.data.length > 0) {
      const petitionIds = results.data.map(chat => chat.id);
      try {
        const qcSubmissions = await QcSubmission.find({ petitionId: { $in: petitionIds } });
        const submittedSet = new Set(qcSubmissions.map(qs => qs.petitionId));
        results.data = results.data.map(chat => ({
          ...chat,
          qcSubmitted: submittedSet.has(chat.id)
        }));
      } catch (dbErr) {
        winstonLogger.warn('Failed to fetch QcSubmissions: ' + dbErr.message);
        results.data.forEach(chat => chat.qcSubmitted = false);
      }
    }

    const qcTokenOverride = req.headers['x-qc-token'];
    // Trigger background sync with QC Portal (fire and forget)
    backgroundQcSync(qcTokenOverride).catch(console.error);

    res.status(200).json(results);
  } catch (error) {
    winstonLogger.error('Error fetching CRM chats:', error.message);
    res.status(500).json({ error: 'Failed to fetch CRM chats' });
  }
};

exports.getChatTranscript = async (req, res) => {
  try {
    const { id } = req.params;
    const token = req.headers['x-crm-token'] || process.env.CRM_ACCESS_TOKEN;
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
