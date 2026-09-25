const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

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
    latitude: Number,   // NEW
    longitude: Number,  // NEW
    deliveryFee: Number,
    status: { type: String, default: 'Pending' }, 
    mpesaReceipt: String,
    checkoutRequestID: String,
    createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// ================================
// SOCKET.IO CONNECTION
// ================================
io.on('connection', (socket) => {
    console.log('🟢 Admin dashboard connected via WebSocket');
    socket.on('disconnect', () => console.log('🔴 Admin dashboard disconnected'));
});

// ================================
// M-PESA FUNCTIONS
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
            latitude: orderDetails.latitude,
            longitude: orderDetails.longitude,
            deliveryFee: amount,
            status: 'Pending'
        });
        await newOrder.save();
        console.log("📦 Order saved:", newOrder._id);
        io.emit('new-order', newOrder);

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

        newOrder.checkoutRequestID = response.data.CheckoutRequestID;
        await newOrder.save();
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("M-Pesa Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: "M-Pesa initiation failed." });
    }
});

app.post('/api/callback', async (req, res) => {
    console.log("Callback:", JSON.stringify(req.body, null, 2));
    try {
        const callbackData = req.body.Body.stkCallback;
        const checkoutRequestID = callbackData.CheckoutRequestID;
        const resultCode = callbackData.ResultCode;
        
        if (resultCode === 0) {
            const mpesaReceipt = callbackData.CallbackMetadata.Item.find(item => item.Name === "MpesaReceiptNumber").Value;
            const updatedOrder = await Order.findOneAndUpdate(
                { checkoutRequestID }, { status: 'Paid', mpesaReceipt }, { new: true }
            );
            if (updatedOrder) io.emit('order-updated', updatedOrder);
        } else {
            const updatedOrder = await Order.findOneAndUpdate(
                { checkoutRequestID }, { status: 'Failed' }, { new: true }
            );
            if (updatedOrder) io.emit('order-updated', updatedOrder);
        }
    } catch (error) {
        console.error("Callback error:", error.message);
    }
    res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// ================================
// ADMIN ENDPOINTS
// ================================
app.get('/api/orders', async (req, res) => {
    try {
        const orders = await Order.find().sort({ createdAt: -1 });
        res.json({ success: true, orders });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch orders" });
    }
});

app.put('/api/orders/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const updatedOrder = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
        if (!updatedOrder) return res.status(404).json({ success: false, error: "Order not found" });
        io.emit('order-updated', updatedOrder);
        res.json({ success: true, order: updatedOrder });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to update status" });
    }
});

app.delete('/api/orders/:id', async (req, res) => {
    try {
        const deletedOrder = await Order.findByIdAndDelete(req.params.id);
        if (!deletedOrder) return res.status(404).json({ success: false, error: "Order not found" });
        io.emit('order-deleted', req.params.id);
        res.json({ success: true, message: "Order deleted" });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to delete order" });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));