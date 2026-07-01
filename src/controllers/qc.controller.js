const axios = require('axios');
const { winstonLogger } = require('../config/logger/winston.config');
const { QcSubmission } = require('../database/schemas/all-schemas');

exports.postToQC = async (req, res) => {
  try {
    const reportData = req.body;
    const qcApiUrl = process.env.QC_API_URL;
    const qcToken = process.env.QC_ACCESS_TOKEN;

    if (!qcApiUrl || qcApiUrl === 'https://your-qc-platform.com/api/v1/reports') {
      return res.status(400).json({ 
        error: 'QC_API_URL is not configured in .env', 
        message: 'Please set your QC platform credentials in the backend .env file.' 
      });
    }

    console.log(`[QC] Forwarding report to QC Platform: ${qcApiUrl}`);

    const validQcTypes = ['ART', 'AHT', 'CRITICAL', 'MISLEADING', 'GRAMETICAL', 'WRONG IDENTIFICATION', 'Escalation Delay', 'In Progress'];
    let finalErrorType = reportData.errorType;
    if (!validQcTypes.includes(finalErrorType)) {
      // Map common fallback severities
      if (['CRITICAL', 'HIGH'].includes(finalErrorType?.toUpperCase())) finalErrorType = 'CRITICAL';
      else finalErrorType = 'In Progress'; // safe fallback
    }

    const payload = {
      entry: {
        petitionNumber: reportData.petitionId || reportData.analysisId || 'UNKNOWN',
        errorType: finalErrorType,
        observation: reportData.observation || reportData.reason || reportData.qaFinding || reportData.overallRecommendation || 'Automated QA Analysis.',
        agentName: reportData.agentName || 'System',
        rawReport: reportData
      }
    };

    // Send the report to the QC Platform
    const response = await axios.post(qcApiUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${qcToken}`
      }
    });

    console.log(`[QC] Successfully posted to QC platform. Status: ${response.status}`);
    
    try {
      await QcSubmission.findOneAndUpdate(
        { petitionId: payload.entry.petitionNumber },
        { 
          $set: { 
            submittedAt: new Date(),
            submittedBy: payload.entry.agentName 
          } 
        },
        { upsert: true, new: true }
      );
    } catch (dbErr) {
      console.log('[QC] Failed to log submission locally:', dbErr.message);
    }
    
    res.status(200).json({ 
      success: true, 
      message: 'Report successfully posted to QC platform.',
      qcResponse: response.data 
    });

  } catch (error) {
    winstonLogger.error('Error posting to QC Platform:', error.message);
    
    // Detailed logging for QC errors
    if (error.response) {
      console.log('QC Platform Response Status:', error.response.status);
      console.log('QC Platform Response Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log('QC Platform Request Error:', error.message);
    }
    
    // If it's an Axios error, try to extract the specific QC platform error message
    const errorDetails = error.response?.data || error.message;
    
    res.status(500).json({ 
      error: 'Failed to post to QC Platform', 
      details: errorDetails 
    });
  }
};
