require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// M-Pesa credentials from Render
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '174379';

let accessToken = '';

// Get M-Pesa token
async function getToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  accessToken = res.data.access_token;
  return accessToken;
}

// 1. STK Push - sends popup to phone
app.post('/stk-push', async (req, res) => {
  const { phone, uid } = req.body;
  
  if (!phone || !uid) {
    return res.status(400).json({ success: false, message: 'Phone and user ID required' });
  }

  try {
    await getToken();
    
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
    
    // Format phone: 0712345678 -> 254712345678
    const formattedPhone = phone.startsWith('0') ? '254' + phone.slice(1) : phone;
    
    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: 1,
        PartyA: formattedPhone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: `https://gbc-stk.onrender.com/mpesa-callback`,
        AccountReference: 'GBC Questions',
        TransactionDesc: 'GBC Premium Unlock'
      },
      {
        headers: { 
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.ResponseCode === '0') {
      await db.collection('pending_payments').doc(response.data.CheckoutRequestID).set({
        uid: uid,
        phone: formattedPhone,
        amount: 1,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: 'pending'
      });
      
      return res.json({ 
        success: true, 
        checkoutRequestID: response.data.CheckoutRequestID,
        message: 'STK Push sent. Check your phone.' 
      });
    } else {
      return res.json({ success: false, message: response.data.ResponseDescription });
    }

  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'STK Push failed' });
  }
});

// 2. M-Pesa Callback - Safaricom calls this after payment
app.post('/mpesa-callback', async (req, res) => {
  const callback = req.body.Body?.stkCallback;
  
  if (!callback) return res.json({ ResultCode: 0 });
  
  const checkoutRequestID = callback.CheckoutRequestID;
  
  if (callback.ResultCode === 0) {
    const metadata = callback.CallbackMetadata.Item;
    const amount = metadata.find(i => i.Name === 'Amount').Value;
    const mpesaCode = metadata.find(i => i.Name === 'MpesaReceiptNumber').Value;
    const phone = metadata.find(i => i.Name === 'PhoneNumber').Value;
    
    const pendingDoc = await db.collection('pending_payments').doc(checkoutRequestID).get();
    
    if (pendingDoc.exists) {
      const uid = pendingDoc.data().uid;
      
      await db.collection('payments').doc(uid).set({
        mpesaCode: mpesaCode,
        phone: phone,
        amount: amount,
        subject: 'GBC Questions',
        checkoutRequestID: checkoutRequestID,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: 'completed'
      });
      
      await db.collection('pending_payments').doc(checkoutRequestID).delete();
    }
  }
  
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// 3. Check if user paid
app.get('/check-payment/:uid', async (req, res) => {
  const { uid } = req.params;
  const doc = await db.collection('payments').doc(uid).get();
  
  if (doc.exists && doc.data().subject === 'GBC Questions') {
    return res.json({ paid: true });
  }
  return res.json({ paid: false });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
