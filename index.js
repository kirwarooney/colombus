const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Helper function to get M-Pesa Access Token
async function getAccessToken() {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    
    const response = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
        headers: { Authorization: `Basic ${auth}` }
    });
    return response.data.access_token;
}

// Endpoint to trigger STK Push (Payment Prompt)
app.post('/api/pay', async (req, res) => {
    try {
        const { phone, amount, orderDetails } = req.body;
        
        // Log the order details so you can see them in Render logs
        console.log("=== NEW ORDER RECEIVED ===");
        console.log("Customer:", orderDetails?.customerName);
        console.log("Location:", orderDetails?.hostel, "Room:", orderDetails?.room);
        console.log("Shop:", orderDetails?.shopName);
        console.log("Item:", orderDetails?.itemDescription);
        console.log("Goods Amount (To pay on delivery):", orderDetails?.goodsAmount * orderDetails?.quantity, "KES");
        console.log("Delivery Fee (Paid now):", amount, "KES");
        console.log("===========================");

        const token = await getAccessToken();
        
        // Timestamp (YYYYMMDDHHmmss)
        const date = new Date();
        const timestamp = date.getFullYear() +
            ("0" + (date.getMonth() + 1)).slice(-2) +
            ("0" + date.getDate()).slice(-2) +
            ("0" + date.getHours()).slice(-2) +
            ("0" + date.getMinutes()).slice(-2) +
            ("0" + date.getSeconds()).slice(-2);

        const shortcode = process.env.MPESA_SHORTCODE;
        const passkey = process.env.MPESA_PASSKEY;
        const password = Buffer.from(shortcode + passkey + timestamp).toString('base64');

        // Safaricom requires the phone number to start with 254, not 0
        let formattedPhone = phone;
        if (phone.startsWith('0')) {
            formattedPhone = '254' + phone.substring(1);
        } else if (phone.startsWith('+')) {
            formattedPhone = phone.substring(1);
        }

        const stkPushData = {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline",
            Amount: amount,
            PartyA: formattedPhone,
            PartyB: shortcode,
            PhoneNumber: formattedPhone,
            CallBackURL: process.env.MPESA_CALLBACK_URL,
            AccountReference: "ColumbusDelivery",
            TransactionDesc: "Delivery Fee Payment"
        };

        const response = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', stkPushData, {
            headers: { Authorization: `Bearer ${token}` }
        });

        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("M-Pesa Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: "Payment initiation failed. Check server logs for details." });
    }
});

// Callback endpoint for M-Pesa results
app.post('/api/callback', (req, res) => {
    console.log("M-Pesa Callback Received:", JSON.stringify(req.body, null, 2));
    // Here you would typically update your database to mark the order as paid
    res.json({ ResultCode: 0, ResultDesc: "Success" });
});

app.get('/', (req, res) => {
    res.send('Delivery app backend is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
