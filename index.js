const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ================================
// DATABASE CONNECTION
// ================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err.message));

// Order Schema
const orderSchema = new mongoose.Schema({
    hostel: String,
    room: String,
    customerName: String,
    shopName: String,
    phone: String,
    itemDescription: String,
    goodsAmount: Number,
    quantity: Number,
    locationPin: String,
    deliveryFee: Number,
    status: { type: String, default: 'Pending' }, // Pending, Paid, Failed
    mpesaReceipt: String,
    checkoutRequestID: String,
    createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// ================================
// M-PESA (SAFARICOM) FUNCTIONS
// ================================
async function getMpesaAccessToken() {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const response = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
        headers: { Authorization: `Basic ${auth}` }
    });
    return response.data.access_token;
}

app.post('/api/pay', async (req, res) => {
    try {
        const { phone, amount, orderDetails } = req.body;
        
        // 1. Save the order to the database FIRST
        const newOrder = new Order({
            hostel: orderDetails.hostel,
            room: orderDetails.room,
            customerName: orderDetails.customerName,
            shopName: orderDetails.shopName,
            phone: phone,
            itemDescription: orderDetails.itemDescription,
            goodsAmount: orderDetails.goodsAmount,
            quantity: orderDetails.quantity,
            locationPin: orderDetails.locationPin,
            deliveryFee: amount,
            status: 'Pending'
        });
        await newOrder.save();
        console.log("📦 Order saved to database:", newOrder._id);

        // 2. Trigger M-Pesa STK Push
        const token = await getMpesaAccessToken();
        const date = new Date();
        const timestamp = date.getFullYear() + ("0" + (date.getMonth() + 1)).slice(-2) + ("0" + date.getDate()).slice(-2) + ("0" + date.getHours()).slice(-2) + ("0" + date.getMinutes()).slice(-2) + ("0" + date.getSeconds()).slice(-2);
        const shortcode = process.env.MPESA_SHORTCODE;
        const passkey = process.env.MPESA_PASSKEY;
        const password = Buffer.from(shortcode + passkey + timestamp).toString('base64');

        let formattedPhone = phone;
        if (phone.startsWith('0')) formattedPhone = '254' + phone.substring(1);
        else if (phone.startsWith('+')) formattedPhone = phone.substring(1);

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

        // 3. Save the CheckoutRequestID to the order so we can match the callback later
        newOrder.checkoutRequestID = response.data.CheckoutRequestID;
        await newOrder.save();

        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("M-Pesa Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: "M-Pesa initiation failed." });
    }
});

// Callback endpoint for M-Pesa results
app.post('/api/callback', async (req, res) => {
    console.log("M-Pesa Callback Received:", JSON.stringify(req.body, null, 2));
    
    try {
        const callbackData = req.body.Body.stkCallback;
        const checkoutRequestID = callbackData.CheckoutRequestID;
        const resultCode = callbackData.ResultCode;
        
        if (resultCode === 0) {
            // Payment successful
            const mpesaReceipt = callbackData.CallbackMetadata.Item.find(item => item.Name === "MpesaReceiptNumber").Value;
            
            // Update the order in the database
            await Order.findOneAndUpdate(
                { checkoutRequestID: checkoutRequestID },
                { status: 'Paid', mpesaReceipt: mpesaReceipt }
            );
            console.log("✅ Order marked as PAID in database.");
        } else {
            // Payment failed
            await Order.findOneAndUpdate(
                { checkoutRequestID: checkoutRequestID },
                { status: 'Failed' }
            );
            console.log("❌ Order payment FAILED.");
        }
    } catch (error) {
        console.error("Error updating order in callback:", error.message);
    }

    res.json({ ResultCode: 0, ResultDesc: "Success" });
});

app.get('/', (req, res) => {
    res.send('Delivery app backend is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});