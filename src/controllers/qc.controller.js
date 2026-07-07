const axios = require('axios');
const { winstonLogger } = require('../config/logger/winston.config');
const { QcSubmission } = require('../database/schemas/all-schemas');

exports.postToQC = async (req, res) => {
  try {
    const reportData = req.body;
    const qcApiUrl = process.env.QC_API_URL;
    const qcToken = req.headers['x-qc-token'] || process.env.QC_ACCESS_TOKEN;

    if (!qcApiUrl || qcApiUrl === 'https://your-qc-platform.com/api/v1/reports') {
      return res.status(400).json({ 
        error: 'QC_API_URL is not configured in .env', 
        message: 'Please set your QC platform credentials in the backend .env file.' 
      });
    }

    if (!qcToken) {
      return res.status(400).json({
        error: 'QC access token is missing.',
        message: 'Please set QC_ACCESS_TOKEN in the backend .env file or provide it via the QC settings.'
      });
    }

    const validQcTypes = ['ART', 'AHT', 'CRITICAL', 'MISLEADING', 'GRAMETICAL', 'WRONG IDENTIFICATION', 'Escalation Delay', 'In Progress'];
    let finalErrorType = reportData.errorType;
    if (!validQcTypes.includes(finalErrorType)) {
      if (['CRITICAL', 'HIGH'].includes(finalErrorType?.toUpperCase())) finalErrorType = 'CRITICAL';
      else finalErrorType = 'In Progress';
    }

    const observationText = reportData.observation || reportData.reason || reportData.qaFinding || reportData.overallRecommendation || 'Automated QA Analysis.';
    const petitionNumber = reportData.petitionId || reportData.analysisId || 'UNKNOWN';
    
    // Get today's date in ISO format (YYYY-MM-DD)
    const today = new Date().toISOString().split('T')[0];

    const payload = {
      entry: {
        petitionNumber,
        errorType: finalErrorType,
        observation: observationText,
        observationDescription: observationText,
        details: observationText,
        agentName: reportData.agentName || 'System',
        date: today,
        createdAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        rawReport: reportData
      }
    };

    console.log(`[QC] Forwarding report to QC Platform: ${qcApiUrl}`);
    console.log(`[QC] Payload petitionNumber: ${petitionNumber}, errorType: ${finalErrorType}, date: ${payload.entry.date}`);

    // ── Step 1: POST to QC Platform ──────────────────────────────────
    let postResponse;
    try {
      postResponse = await axios.post(qcApiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${qcToken}`
        },
        timeout: 15000
      });
    } catch (axiosErr) {
      // Axios throws on 4xx/5xx — extract the real QC API error message
      const qcStatus = axiosErr.response?.status;
      const qcData   = axiosErr.response?.data;

      console.error(`[QC] POST failed. HTTP ${qcStatus}:`, JSON.stringify(qcData));
      winstonLogger.error(`[QC] POST failed. HTTP ${qcStatus}: ${JSON.stringify(qcData)}`);

      // Surface the exact QC API error to the frontend
      const qcMessage = qcData?.message || qcData?.error || axiosErr.message;
      return res.status(502).json({
        error: `QC Platform rejected the request (HTTP ${qcStatus}).`,
        message: qcMessage,
        details: qcData
      });
    }

    console.log(`[QC] POST response HTTP ${postResponse.status}:`, JSON.stringify(postResponse.data));

    // ── Step 2: Validate the QC API response body ────────────────────
    // The QC API returns { success: true/false, message, data/entry }
    const qcBody = postResponse.data;

    if (qcBody?.success === false) {
      const qcMessage = qcBody.message || 'QC Platform returned success: false without a reason.';
      console.error('[QC] QC API returned success:false —', qcMessage);
      return res.status(502).json({
        error: 'QC Platform did not confirm creation.',
        message: qcMessage,
        details: qcBody
      });
    }

    // ── Step 3: Extract the created entry ID from the response ───────
    // Common shapes: { data: { _id, id } } or { entry: { _id } } or { _id } at root
    const createdEntry = qcBody?.data || qcBody?.entry || qcBody;
    const createdId = createdEntry?._id || createdEntry?.id || createdEntry?.entryId || null;

    console.log(`[QC] Entry created. ID: ${createdId || '(not returned by API)'}`);

    // ── Step 4: Verify the created entry exists (if API supports GET by ID) ──
    let verifiedEntry = null;
    if (createdId && process.env.QC_GET_API_URL) {
      try {
        // Build a verification URL: replace the entries path with entries/:id
        const verifyUrl = `${qcApiUrl}/${createdId}`;
        const verifyResponse = await axios.get(verifyUrl, {
          headers: { 'Authorization': `Bearer ${qcToken}` },
          timeout: 8000
        });
        verifiedEntry = verifyResponse.data?.data || verifyResponse.data?.entry || verifyResponse.data;
        console.log(`[QC] Verification GET confirmed entry exists. ID: ${createdId}`);
      } catch (verifyErr) {
        // Verification is best-effort — log but do not fail the submission
        console.warn(`[QC] Verification GET failed (non-critical): ${verifyErr.message}`);
      }
    }

    // ── Step 5: Log submission locally ──────────────────────────────
    try {
      await QcSubmission.findOneAndUpdate(
        { petitionId: petitionNumber },
        { $set: { submittedAt: new Date(), submittedBy: payload.entry.agentName } },
        { upsert: true, new: true }
      );
    } catch (dbErr) {
      console.warn('[QC] Failed to log submission locally (non-critical):', dbErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Observation successfully created in QC Platform.',
      createdId,
      verifiedEntry,
      qcResponse: qcBody
    });

  } catch (error) {
    winstonLogger.error('Unexpected error in postToQC:', error.message);
    console.error('[QC] Unexpected error:', error.message);
    return res.status(500).json({
      error: 'Unexpected server error while posting to QC Platform.',
      details: error.message
    });
  }
};
